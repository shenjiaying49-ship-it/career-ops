// 待入库队列的文件存储（career-ops/data/network-pending.json）。
// 被 queue-import（Agent 写入）、pending（浏览器读/清）、ingest（桥接推送）共用。

import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

const MAX_PENDING = 100;

function pendingPath() {
  return path.join(careerOpsRoot(), "data", "network-pending.json");
}

export function readPending(): unknown[] {
  try {
    const arr = JSON.parse(fs.readFileSync(pendingPath(), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function pushPending(item: unknown): number {
  const items = readPending();
  items.push(item);
  const kept = items.slice(-MAX_PENDING);
  writePending(kept);
  return kept.length;
}

export function removePending(ids: string[]): number {
  const set = new Set(ids);
  const items = readPending().filter((x) => {
    const id = (x as { id?: string }).id;
    return !id || !set.has(id);
  });
  writePending(items);
  return items.length;
}

function writePending(items: unknown[]) {
  fs.mkdirSync(path.dirname(pendingPath()), { recursive: true });
  fs.writeFileSync(pendingPath(), JSON.stringify(items, null, 2), "utf8");
}
