/**
 * Auto-pagination helpers for the common API patterns.
 */

export interface PageResult<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
  nextPage?: number;
  total?: number;
}

/**
 * Paginate through a page-based API. The callback receives the page number
 * and returns items plus metadata.
 */
export async function paginatePages<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; pages: number; total: number }>,
  opts: { maxItems?: number } = {},
): Promise<{ items: T[]; total: number }> {
  const allItems: T[] = [];
  let page = 1;
  let totalPages = 1;
  let total = 0;

  while (page <= totalPages) {
    const result = await fetchPage(page);
    allItems.push(...result.items);
    totalPages = result.pages;
    total = result.total;

    if (opts.maxItems && allItems.length >= opts.maxItems) {
      return { items: allItems.slice(0, opts.maxItems), total };
    }

    page++;
  }

  return { items: allItems, total };
}

/**
 * Paginate through a cursor-based API. The callback receives the cursor
 * (undefined for the first page) and returns items plus the next cursor.
 */
export async function paginateCursor<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
  opts: { maxItems?: number } = {},
): Promise<T[]> {
  const allItems: T[] = [];
  let cursor: string | undefined;

  do {
    const result = await fetchPage(cursor);
    allItems.push(...result.items);
    cursor = result.nextCursor;

    if (opts.maxItems && allItems.length >= opts.maxItems) {
      return allItems.slice(0, opts.maxItems);
    }
  } while (cursor);

  return allItems;
}

/**
 * Extract the next-page cursor from an RFC 5988 Link header, for APIs that
 * paginate via a cursor parameter in a rel="next" link.
 */
export function parseLinkHeaderCursor(
  linkHeader: string | null,
  param = "page_info",
): string | undefined {
  if (!linkHeader) return undefined;
  const match = linkHeader.match(
    new RegExp(`<[^>]*${param}=([^&>]+)[^>]*>;\\s*rel="next"`),
  );
  return match?.[1];
}
