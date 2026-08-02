import type { MaestroTreeNode } from "@olive-remote-lab/olive-client";

const TITLE_COLLATOR = new Intl.Collator(undefined, {
  usage: "sort",
  sensitivity: "base",
  numeric: true,
});

export function alphabetizeLibraryItems(items: MaestroTreeNode[]): MaestroTreeNode[] {
  return [...items].sort((left, right) => (
    TITLE_COLLATOR.compare(left.title.trim(), right.title.trim())
    || left.id.localeCompare(right.id)
  ));
}
