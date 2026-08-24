import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './atomic';
import { fileCache } from './filecache';
import { OpError } from './ops';

// Topics: free-form tags on a repository, the way GitHub carries them. A topic
// is organizational and nothing else -- it grants nothing, reserves nothing,
// and exists only because some repository carries it; the set of topics in a
// vault is whatever its repositories say, with no registry behind it, exactly
// as issue labels work.
//
// They live in a `topics` file in the bare repository's directory, one per
// line, beside git's own `description` file: plain enough to read and edit by
// hand, and it moves with the repository when the repository is renamed. A
// repository with no such file has no topics, which is what every repository
// had before this existed.

/** The most topics a repository may carry, matching GitHub's cap. */
export const MAX_TOPICS = 20;

/** The longest a single topic may be, matching GitHub's cap. */
export const MAX_TOPIC_LENGTH = 50;

/**
 * The GitHub rule, exactly: lowercase letters, digits, and hyphens, starting
 * with a letter or digit. Lowercase-only is what keeps a topic usable in a URL
 * with no escaping, and what makes "WebGPU" and "webgpu" one topic rather
 * than two that each list half the repositories.
 */
export function isValidTopic(topic: string): boolean {
  return topic.length <= MAX_TOPIC_LENGTH && /^[a-z0-9][a-z0-9-]*$/.test(topic);
}

/**
 * Validate a proposed set of topics: trim, drop empties, dedupe, refuse what
 * the rule refuses. Rejection rather than normalization on purpose -- a
 * caller who typed "WebGPU" is told what to type instead of having their
 * input silently rewritten -- but the refusal names the fix when lowercasing
 * is the fix.
 */
export function checkTopics(topics: string[]): string[] {
  const out: string[] = [];
  for (const raw of topics) {
    const topic = raw.trim();
    if (topic === '') continue;
    if (!isValidTopic(topic)) {
      const lowered = topic.toLowerCase();
      const hint = topic !== lowered && isValidTopic(lowered) ? ` (try "${lowered}")` : '';
      throw new OpError(
        `"${topic}" is not a usable topic: lowercase letters, digits, and hyphens, starting with a letter or digit, at most ${MAX_TOPIC_LENGTH} characters${hint}`
      );
    }
    if (!out.includes(topic)) out.push(topic);
  }
  if (out.length > MAX_TOPICS) throw new OpError(`A repository may carry at most ${MAX_TOPICS} topics.`);
  return out;
}

/**
 * Topics as a person types them into one input: separated by spaces, commas,
 * or both. The web forms parse with this and then validate with checkTopics,
 * so the two forms and the API refuse the same things.
 */
export function parseTopicsInput(text: string): string[] {
  return text.split(/[\s,]+/).filter((t) => t !== '');
}

export const TOPICS_FILE = 'topics';

const topicsCache = fileCache<string[]>({
  read: (file) => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    // Reading stays permissive, as everywhere: a hand-edited file's invalid
    // lines are skipped rather than the valid ones going unserved, and a
    // file grown past the cap is capped rather than swelling every listing.
    const out: string[] = [];
    for (const line of text.split('\n')) {
      const topic = line.trim();
      if (topic !== '' && isValidTopic(topic) && !out.includes(topic)) out.push(topic);
      if (out.length === MAX_TOPICS) break;
    }
    return out;
  },
  missing: () => [],
});

/** The topics of the repository whose bare directory this is. */
export function repoTopics(repoDir: string): string[] {
  return topicsCache.get(path.join(repoDir, TOPICS_FILE));
}

/**
 * Replace the repository's topics with these, validated. The whole set at
 * once, as GitHub's API takes them: add-one and remove-one are a caller's
 * read-modify-write, not a protocol.
 */
export function setTopics(repoDir: string, topics: string[]): string[] {
  const checked = checkTopics(topics);
  const file = path.join(repoDir, TOPICS_FILE);
  if (checked.length === 0) {
    fs.rmSync(file, { force: true });
  } else {
    writeFileAtomic(file, checked.join('\n') + '\n');
  }
  topicsCache.invalidate(file);
  return checked;
}

/**
 * The topics a set of repositories carries, with how many carry each, most
 * used first. Both the listing dropdowns and the topics index are built from
 * this, always over repositories the viewer could see anyway.
 */
export function countTopics(topicLists: string[][]): { topic: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const list of topicLists) {
    for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}
