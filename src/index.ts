#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "1.0.0";
const REPO_URL = "https://github.com/aminamos/forummagnum-mcp";
const USER_AGENT = `forummagnum-mcp/${VERSION} (${REPO_URL})`;

const SITES = {
  lesswrong: "https://www.lesswrong.com",
  eaforum: "https://forum.effectivealtruism.org",
} as const;
type SiteName = keyof typeof SITES;

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;
const MAX_STRING_LEN = 1000;
const MAX_BODY_LEN = 4000;
const MAX_OUTPUT_CHARS = 20000;
const MAX_OFFSET = 2000; // upstream hard ceiling; we never paginate this deep

// Long-text fields that deserve a bigger trim budget than plain metadata.
const BODY_KEYS: Record<string, true> = {
  plaintextMainText: true,
  plaintextDescription: true,
  markdown: true,
  html: true,
  bio: true,
  body: true,
};
let lastRequestAt = 0;
const MIN_GAP_MS = 1500;

async function backoff(ms: number): Promise<void> {
  const gate = Promise.withResolvers<void>();
  setTimeout(gate.resolve, ms);
  await gate.promise;
}

async function politeFetch(
  url: string,
  init: RequestInit,
  retries = 3,
): Promise<Response> {
  const now = Date.now();
  const gap = MIN_GAP_MS - (now - lastRequestAt) + Math.random() * 500;
  if (gap > 0) await backoff(gap);

  let delayMs = 2000;
  for (let attempt = 0; ; attempt++) {
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await backoff(delayMs + Math.random() * 1000);
        delayMs *= 2;
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      await backoff(delayMs + Math.random() * 1000);
      delayMs *= 2;
    }
  }
}

// ---------------------------------------------------------------------------
// Output trimming
// ---------------------------------------------------------------------------
function trimWithBudgets(value: unknown, strMax: number, bodyMax: number): unknown {
  if (typeof value === "string") {
    return value.length > strMax ? value.slice(0, strMax) + "…" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => trimWithBudgets(item, strMax, bodyMax));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && BODY_KEYS[k] && v.length > bodyMax) {
        out[k] = v.slice(0, bodyMax) + "…";
      } else {
        out[k] = trimWithBudgets(v, strMax, bodyMax);
      }
    }
    return out;
  }
  return value;
}

// Serialize to valid JSON that always fits the cap: first drop trailing rows,
// then shrink string budgets. Output is always parseable.
function render(
  payload: Record<string, unknown>,
): { content: { type: "text"; text: string }[] } {
  const meta = { ...(payload["meta"] as Record<string, unknown> ?? {}) };
  let strMax = MAX_STRING_LEN;
  let bodyMax = MAX_BODY_LEN;
  let trimmed = trimWithBudgets(payload, strMax, bodyMax) as Record<string, unknown>;
  let text = JSON.stringify(trimmed, null, 2);
  const results = trimmed["results"];
  if (Array.isArray(results)) {
    let kept = results.length;
    while (kept > 1 && text.length > MAX_OUTPUT_CHARS) {
      kept -= 1;
      meta["truncatedFrom"] = results.length;
      trimmed = { ...trimmed, results: results.slice(0, kept), meta };
      text = JSON.stringify(trimmed, null, 2);
    }
  }
  while (text.length > MAX_OUTPUT_CHARS && (strMax > 100 || bodyMax > 200)) {
    strMax = Math.max(100, Math.floor(strMax / 2));
    bodyMax = Math.max(200, Math.floor(bodyMax / 2));
    meta["retrimmed"] = true;
    trimmed = {
      ...(trimWithBudgets(payload, strMax, bodyMax) as Record<string, unknown>),
      meta: { ...(payload["meta"] as Record<string, unknown> ?? {}), ...meta },
    };
    text = JSON.stringify(trimmed, null, 2);
  }
  return { content: [{ type: "text" as const, text }] };
}

function toolError(err: unknown): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Native search proxy (the same POST /api/search the site frontends use).
// Indices are named test_<collection>[_<sorting>]; no auth needed.
// ---------------------------------------------------------------------------
const SEARCH_COLLECTIONS = [
  "posts",
  "comments",
  "users",
  "tags",
  "sequences",
] as const;
type SearchCollection = (typeof SEARCH_COLLECTIONS)[number];

const SORT_SUFFIX: Record<string, string> = {
  relevance: "",
  karma: "_karma",
  newest_first: "_newest_first",
  oldest_first: "_oldest_first",
};

async function nativeSearch(
  site: SiteName,
  collection: SearchCollection,
  query: string,
  limit: number,
  sort: string,
): Promise<{ hits: unknown[]; index: string }> {
  const index = `test_${collection}${SORT_SUFFIX[sort] ?? ""}`;
  const res = await politeFetch(`${SITES[site]}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      options: { emptyStringSearchResults: "default" },
      queries: [
        {
          indexName: index,
          query,
          params: { query, hitsPerPage: limit, page: 0 },
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Search API error ${res.status} for ${site}/${index}`);
  }
  const body = (await res.json()) as { hits?: unknown[] }[];
  const hits = Array.isArray(body?.[0]?.hits) ? body[0].hits : [];
  return { hits, index };
}

// ---------------------------------------------------------------------------
// GraphQL. LessWrong runs the newer selector/limit convention, the EA Forum
// runs the older input:{terms} convention — same fields, different envelope.
// ---------------------------------------------------------------------------
async function graphql(
  site: SiteName,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await politeFetch(`${SITES[site]}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL HTTP error ${res.status} for ${site}`);
  }
  const body = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: { message?: string }[];
  };
  if (body.errors?.length) {
    throw new Error(`GraphQL error: ${body.errors[0]?.message ?? "unknown"}`);
  }
  return body.data ?? {};
}

const POST_FIELDS = `
  _id title slug postedAt pageUrl baseScore commentCount question
  wordCount readTimeMinutes
  user { displayName slug karma }
`.trim();

const POST_BODY = `contents { plaintextMainText wordCount }`;
const COMMENT_FIELDS = `
  _id postId postedAt baseScore
  user { displayName slug }
  contents { plaintextMainText }
`.trim();
const USER_FIELDS = `
  _id slug displayName karma postCount commentCount bio pageUrl
`.trim();
const TAG_FIELDS = `
  _id name slug shortName postCount
  description { plaintextMainText }
`.trim();

function pluralPostsArgs(
  site: SiteName,
  selectorTerms: string,
  limit: number,
): string {
  // selectorTerms: `curated:{}` (LW) or `view:"curated"` (EA terms field)
  if (site === "lesswrong") {
    return `(selector:{${selectorTerms}},limit:${limit})`;
  }
  return `(input:{terms:{${selectorTerms},limit:${limit}}})`;
}

async function fetchPostById(
  site: SiteName,
  id: string,
  includeBody: boolean,
): Promise<Record<string, unknown> | null> {
  const sel = site === "lesswrong" ? `(selector:{_id:"${id}"})` : `(input:{selector:{_id:"${id}"}})`;
  const data = await graphql(
    site,
    `{post${sel}{result{${POST_FIELDS} ${includeBody ? POST_BODY : ""}}}}`,
  );
  const post = data["post"] as { result?: Record<string, unknown> } | null;
  return post?.result ?? null;
}

async function fetchPostBySlug(
  site: SiteName,
  slug: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const args =
    site === "lesswrong"
      ? `(selector:{slugPost:{slug:"${slug}"}},limit:${limit})`
      : `(input:{terms:{view:"slugPost",slug:"${slug}",limit:${limit}}})`;
  const data = await graphql(
    site,
    `{posts${args}{results{${POST_FIELDS}}}}`,
  );
  const posts = data["posts"] as { results?: Record<string, unknown>[] };
  return posts?.results ?? [];
}

async function fetchCommentsForPost(
  site: SiteName,
  postId: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const args =
    site === "lesswrong"
      ? `(selector:{postsItemComments:{postId:"${postId}"}},limit:${limit})`
      : `(input:{terms:{view:"postsItemComments",postId:"${postId}",limit:${limit}}})`;
  const data = await graphql(
    site,
    `{comments${args}{results{${COMMENT_FIELDS}}}}`,
  );
  const comments = data["comments"] as { results?: Record<string, unknown>[] };
  return comments?.results ?? [];
}

// ---------------------------------------------------------------------------
// Input schema helpers
// ---------------------------------------------------------------------------
const siteField = z
  .enum(["lesswrong", "eaforum"])
  .default("lesswrong")
  .describe("Which forum to query: lesswrong or eaforum.");

const limitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(`Max rows to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`);

const sortField = z
  .enum(["relevance", "karma", "newest_first", "oldest_first"])
  .default("relevance")
  .describe("Result ordering (search indices only).");

function clampLimit(limit: unknown): number {
  return typeof limit === "number" && Number.isFinite(limit)
    ? Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "forummagnum-mcp", version: VERSION });

server.registerTool(
  "search_posts",
  {
    description:
      "Full-text search over posts (title + body) via the site's own search index. Returns trimmed hits with ids, slugs, scores, tags, and authors.",
    inputSchema: {
      query: z.string().describe("Full-text search query."),
      site: siteField,
      limit: limitField,
      sort: sortField,
    },
  },
  async (args) => {
    try {
      const n = clampLimit(args.limit);
      const { hits, index } = await nativeSearch(
        args.site as SiteName,
        "posts",
        args.query as string,
        n,
        (args.sort as string) ?? "relevance",
      );
      return render({
        results: hits,
        meta: {
          site: args.site,
          index,
          query: args.query,
          count: hits.length,
          maxOffset: MAX_OFFSET,
        },
      });
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "search_comments",
  {
    description:
      "Full-text search over comments via the site's own search index. Returns trimmed hits with parent post ids/slugs and authors.",
    inputSchema: {
      query: z.string().describe("Full-text search query."),
      site: siteField,
      limit: limitField,
      sort: sortField,
    },
  },
  async (args) => {
    try {
      const n = clampLimit(args.limit);
      const { hits, index } = await nativeSearch(
        args.site as SiteName,
        "comments",
        args.query as string,
        n,
        (args.sort as string) ?? "relevance",
      );
      return render({
        results: hits,
        meta: {
          site: args.site,
          index,
          query: args.query,
          count: hits.length,
          maxOffset: MAX_OFFSET,
        },
      });
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "search_users",
  {
    description:
      "Search user accounts by name via the site's own search index. Returns display names, slugs, karma, and links.",
    inputSchema: {
      query: z.string().describe("Name to search for."),
      site: siteField,
      limit: limitField,
    },
  },
  async (args) => {
    try {
      const n = clampLimit(args.limit);
      const { hits, index } = await nativeSearch(
        args.site as SiteName,
        "users",
        args.query as string,
        n,
        "relevance",
      );
      return render({
        results: hits,
        meta: {
          site: args.site,
          index,
          query: args.query,
          count: hits.length,
        },
      });
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "search_tags",
  {
    description:
      "Search wiki tags/topics by name via the site's own search index. Returns names, slugs, and post counts.",
    inputSchema: {
      query: z.string().describe("Tag name to search for."),
      site: siteField,
      limit: limitField,
    },
  },
  async (args) => {
    try {
      const n = clampLimit(args.limit);
      const { hits, index } = await nativeSearch(
        args.site as SiteName,
        "tags",
        args.query as string,
        n,
        "relevance",
      );
      return render({
        results: hits,
        meta: {
          site: args.site,
          index,
          query: args.query,
          count: hits.length,
        },
      });
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "search_sequences",
  {
    description:
      "Search curated sequences/collections by title via the site's own search index.",
    inputSchema: {
      query: z.string().describe("Sequence title to search for."),
      site: siteField,
      limit: limitField,
    },
  },
  async (args) => {
    try {
      const n = clampLimit(args.limit);
      const { hits, index } = await nativeSearch(
        args.site as SiteName,
        "sequences",
        args.query as string,
        n,
        "relevance",
      );
      return render({
        results: hits,
        meta: {
          site: args.site,
          index,
          query: args.query,
          count: hits.length,
        },
      });
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "get_post",
  {
    description:
      "Fetch a single post by id or slug, with optional body text and top comments. One of id/slug is required.",
    inputSchema: {
      site: siteField,
      id: z.string().optional().describe("Post _id (e.g. bGn9ZjeuJCg7HkKBj)."),
      slug: z
        .string()
        .optional()
        .describe("URL slug (e.g. introducing-alignmentsearch-an-ai-alignment-informed)."),
      includeBody: z
        .boolean()
        .default(true)
        .describe("Include trimmed plaintext body (default true)."),
      topComments: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(5)
        .describe("How many top comments to include (0-20, default 5)."),
    },
  },
  async (args) => {
    try {
      const site = args.site as SiteName;
      const id = args.id as string | undefined;
      const slug = args.slug as string | undefined;
      if (!id && !slug) {
        throw new Error("Provide id or slug.");
      }
      const includeBody = (args.includeBody as boolean) !== false;
      const nComments = Math.min(
        Math.max(Math.floor((args.topComments as number) ?? 5), 0),
        20,
      );
      let post: Record<string, unknown> | null = null;
      if (id) {
        post = await fetchPostById(site, id, includeBody);
      } else {
        const found = await fetchPostBySlug(site, slug as string, 1);
        post = found[0] ?? null;
        if (post && includeBody && !post["contents"]) {
          post = await fetchPostById(site, post["_id"] as string, true);
        }
      }
      if (!post) throw new Error("Post not found.");
      const comments =
        nComments > 0
          ? await fetchCommentsForPost(site, post["_id"] as string, nComments)
          : [];
      return render({
        result: { ...post, topComments: comments },
        meta: { site, commentCount: comments.length },
      });
    } catch (err) {
      return toolError(err);
    }
  },
);

const LIST_VIEWS = ["frontpage", "curated", "top", "new"] as const;

server.registerTool(
  "list_posts",
  {
    description:
      "List recent posts from a frontpage/curated/top/new feed via GraphQL. No deep pagination (limit ≤ 25).",
    inputSchema: {
      site: siteField,
      view: z
        .enum(LIST_VIEWS as unknown as [string, ...string[]])
        .default("frontpage")
        .describe("Feed view (default frontpage)."),
      limit: limitField,
    },
  },
  async (args) => {
    try {
      const site = args.site as SiteName;
      const view = (args.view as string) ?? "frontpage";
      const n = clampLimit(args.limit);
      const selectorTerms =
        site === "lesswrong" ? `${view}:{}` : `view:"${view}"`;
      const data = await graphql(
        site,
        `{posts${pluralPostsArgs(site, selectorTerms, n)}{results{${POST_FIELDS}}}}`,
      );
      const posts = data["posts"] as { results?: unknown[] };
      const results = posts?.results ?? [];
      return render({
        results,
        meta: { site, view, count: results.length, maxOffset: MAX_OFFSET },
      });
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "get_user",
  {
    description:
      "Fetch a user profile by slug or id (display name, karma, post/comment counts, bio). One of slug/id is required.",
    inputSchema: {
      site: siteField,
      slug: z.string().optional().describe("Profile slug."),
      id: z.string().optional().describe("User _id."),
    },
  },
  async (args) => {
    try {
      const site = args.site as SiteName;
      const slug = args.slug as string | undefined;
      const id = args.id as string | undefined;
      if (!slug && !id) throw new Error("Provide slug or id.");
      let user: unknown = null;
      if (slug) {
        const data = await graphql(
          site,
          `query($s:String!){GetUserBySlug(slug:$s){${USER_FIELDS}}}`,
          { s: slug },
        );
        user = data["GetUserBySlug"] ?? null;
      } else {
        const sel =
          site === "lesswrong"
            ? `(selector:{_id:"${id}"})`
            : `(input:{selector:{_id:"${id}"}})`;
        const data = await graphql(site, `{user${sel}{result{${USER_FIELDS}}}}`);
        const u = data["user"] as { result?: unknown } | null;
        user = u?.result ?? null;
      }
      if (!user) throw new Error("User not found.");
      return render({ result: user, meta: { site } });
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "get_tag",
  {
    description:
      "Fetch a wiki tag/topic by slug (name, post count, trimmed description).",
    inputSchema: {
      site: siteField,
      slug: z.string().describe("Tag slug (e.g. ai, rationality)."),
    },
  },
  async (args) => {
    try {
      const site = args.site as SiteName;
      const slug = args.slug as string;
      const eaEscaped = slug.replace(/"/g, "");
      const queryArgs =
        site === "lesswrong"
          ? `(selector:{tagBySlug:{slug:"${eaEscaped}"}},limit:1)`
          : `(input:{terms:{view:"tagBySlug",slug:"${eaEscaped}"}})`;
      const data = await graphql(
        site,
        `{tags${queryArgs}{results{${TAG_FIELDS}}}}`,
      );
      const tags = data["tags"] as { results?: unknown[] };
      const tag = tags?.results?.[0] ?? null;
      if (!tag) throw new Error("Tag not found.");
      return render({ result: tag, meta: { site } });
    } catch (err) {
      return toolError(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
