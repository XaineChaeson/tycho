// What a round's receipt says of a pull request, declared once: the shape an address must have
// and the words the entrances refuse it with. The receipt is the round's own words, and the
// address goes into another round's brief, so anything that could read as an option or an
// instruction there is refused where it enters, not warned against in the brief. Read by the
// merge entry, the task page and the settlement that takes a round's delivery, so none of them
// can come to a different conclusion about the same receipt.

// Basic URL hygiene for a pull/merge request address: valid http(s) URL without whitespace or control chars.
const UNSAFE_URL_CHARS = /[\s\u0000-\u001F\u007F]/;

function isValidPullRequestUrl(link: string): boolean {
  if (link.length === 0 || UNSAFE_URL_CHARS.test(link)) return false;
  try {
    const parsed = new URL(link);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export const PULL_REQUEST_FORM = '有效的 http:// 或 https:// 网址';
export const pullRequestCountText = (count: number): string => `这一轮的回执里有 ${count} 个 PR：说不清合哪一个，不合`;
export const pullRequestShapeText = `这一轮回执里的 PR 不是有效的网址（${PULL_REQUEST_FORM}）：不合`;

// The one pull request a receipt names, why what it names cannot be told, or none. More than
// one is a problem, not a choice for the caller to make.
export type PullRequestReading = { url: string } | { problem: string } | null;

export function pullRequestReading(receipt: unknown): PullRequestReading {
  const artifacts = (receipt as { artifacts?: unknown } | null)?.artifacts;
  const links = Array.isArray(artifacts)
    ? artifacts.filter((each) => (each as { kind?: unknown })?.kind === 'pr').map((each) => (each as { ref?: unknown }).ref)
    : [];
  if (links.length > 1) return { problem: pullRequestCountText(links.length) };
  if (links.length === 0) return null;
  const [link] = links;
  if (typeof link !== 'string' || !isValidPullRequestUrl(link)) return { problem: pullRequestShapeText };
  return { url: link };
}

// Why a receipt's pull request cannot be used, or null when it names none or a usable one.
export function pullRequestProblem(receipt: unknown): string | null {
  const reading = pullRequestReading(receipt);
  return reading !== null && 'problem' in reading ? reading.problem : null;
}
