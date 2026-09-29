/**
 * Query expansion for full-text search.
 *
 * Ported from OpenClaw's query expansion module and adapted for Cosmos DB.
 * Extracts meaningful keywords from conversational EN/ZH queries to improve
 * FullTextScore quality.
 */

const STOP_WORDS_EN = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "they", "them",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "can", "may", "might",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "about", "into",
  "through", "during", "before", "after", "above", "below", "between", "under", "over",
  "and", "or", "but", "if", "then", "because", "as", "while", "when", "where", "what",
  "which", "who", "how", "why",
  "yesterday", "today", "tomorrow", "earlier", "later", "recently", "ago", "just", "now",
  "thing", "things", "stuff", "something", "anything", "everything", "nothing",
  "please", "help", "find", "show", "get", "tell", "give",
]);

const STOP_WORDS_ZH = new Set([
  "我", "我们", "你", "你们", "他", "她", "它", "他们", "这", "那", "这个", "那个", "这些", "那些",
  "的", "了", "着", "过", "得", "地", "吗", "呢", "吧", "啊", "呀", "嘛", "啦",
  "是", "有", "在", "被", "把", "给", "让", "用", "到", "去", "来", "做", "说", "看", "找", "想", "要", "能", "会", "可以",
  "和", "与", "或", "但", "但是", "因为", "所以", "如果", "虽然", "而", "也", "都", "就", "还", "又", "再", "才", "只",
  "之前", "以前", "之后", "以后", "刚才", "现在", "昨天", "今天", "明天", "最近",
  "东西", "事情", "事", "什么", "哪个", "哪些", "怎么", "为什么", "多少",
  "请", "帮", "帮忙", "告诉",
]);

function isValidKeyword(token: string): boolean {
  if (!token) return false;
  if (/^[a-zA-Z]+$/.test(token) && token.length < 3) return false;
  if (/^\d+$/.test(token)) return false;
  if (/^[\p{P}\p{S}]+$/u.test(token)) return false;
  return true;
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase().trim();
  const segments = normalized.split(/[\s\p{P}]+/u).filter(Boolean);

  for (const segment of segments) {
    if (/[\u4e00-\u9fff]/.test(segment)) {
      const chars = Array.from(segment).filter((char) => /[\u4e00-\u9fff]/.test(char));
      tokens.push(...chars);
      for (let index = 0; index < chars.length - 1; index++) {
        tokens.push(chars[index] + chars[index + 1]);
      }
    } else {
      tokens.push(segment);
    }
  }

  return tokens;
}

export function extractKeywords(query: string): string[] {
  const tokens = tokenize(query);
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (STOP_WORDS_EN.has(token) || STOP_WORDS_ZH.has(token)) continue;
    if (!isValidKeyword(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
  }

  return keywords;
}

export function expandQueryForFts(query: string): {
  original: string;
  keywords: string[];
  expanded: string;
} {
  const original = query.trim();
  const keywords = extractKeywords(original);
  const expanded = keywords.length > 0 ? `${original} OR ${keywords.join(" OR ")}` : original;
  return { original, keywords, expanded };
}
