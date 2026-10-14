/**
 * Runs `task` on every item with at most `concurrency` tasks in flight. The first failure rejects
 * the whole run, and the other workers stop taking new items (their current task still ends).
 */
export async function inPool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && cursor < items.length) {
      const item = items[cursor++] as T;
      try {
        await task(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  if (items.length === 0) return;
  const width = Math.min(
    items.length,
    Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 1,
  );
  await Promise.all(Array.from({ length: width }, worker));
}
