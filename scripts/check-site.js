import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const errors = [];
const htmlFiles = [];
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const OPTIONAL_END_TAGS = new Set(["li", "p", "dt", "dd", "rt", "rp", "optgroup", "option", "colgroup", "thead", "tbody", "tfoot", "tr", "td", "th"]);
const CLOSE_ON_START = new Map([
  ["li", new Set(["li"])],
  ["p", new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul"])],
  ["dt", new Set(["dd", "dt"])],
  ["dd", new Set(["dd", "dt"])],
  ["option", new Set(["option", "optgroup"])],
  ["tr", new Set(["tr"])],
  ["td", new Set(["td", "th"])],
  ["th", new Set(["td", "th"])],
]);

function walk(directory, relativeDirectory = "") {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(absolutePath, relativePath));
    else if (entry.isFile() && /\.html$/i.test(entry.name)) found.push({ absolutePath, relativePath });
  }
  return found;
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function pageUrl(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized === "index.html") return "/";
  if (normalized.endsWith("/index.html")) return `/${normalized.slice(0, -"index.html".length)}`;
  return `/${normalized}`;
}

function checkTagNesting(html, label) {
  const withoutRawText = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  const stack = [];
  const tokenPattern = /<![^>]*>|<\/?[a-z][^>]*>/gi;
  for (const match of withoutRawText.matchAll(tokenPattern)) {
    const token = match[0];
    if (/^<!/i.test(token)) continue;
    const closing = /^<\//.test(token);
    const name = token.match(/^<\/?\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase();
    if (!name) continue;

    if (closing) {
      const top = stack.at(-1);
      if (top === name) {
        stack.pop();
      } else if (OPTIONAL_END_TAGS.has(name) && !stack.includes(name)) {
        continue;
      } else {
        const index = stack.lastIndexOf(name);
        if (index >= 0 && stack.slice(index + 1).every((tag) => OPTIONAL_END_TAGS.has(tag))) {
          stack.length = index;
        } else {
          errors.push(`${label}: unexpected closing </${name}>${top ? ` while <${top}> is open` : ""}`);
        }
      }
      continue;
    }

    const top = stack.at(-1);
    if (top && CLOSE_ON_START.get(top)?.has(name)) stack.pop();
    if (!VOID_ELEMENTS.has(name) && !/\/\s*>$/.test(token)) stack.push(name);
  }
  for (const name of stack) {
    if (!OPTIONAL_END_TAGS.has(name)) errors.push(`${label}: unclosed <${name}> element`);
  }
}

function resolveInternal(target, currentUrl) {
  const decoded = decodeURIComponent(target);
  const targetUrl = new URL(decoded, `https://pumpfiat.local${currentUrl}`);
  const pathname = decodeURIComponent(targetUrl.pathname);
  const diskPath = path.resolve(DIST, `.${pathname}`);
  if (diskPath !== DIST && !diskPath.startsWith(`${DIST}${path.sep}`)) return null;
  const candidates = [
    diskPath,
    path.join(diskPath, "index.html"),
    `${diskPath}.html`,
  ];
  const match = candidates.find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
  return { pathname, hash: targetUrl.hash.slice(1), file: match || null };
}

function checkLinks(file, relativePath, html) {
  const currentUrl = pageUrl(relativePath);
  const visibleHtml = html
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, "$1</script>")
    .replace(/<header\b[^>]*\shidden(?:\s|=|>)[^>]*>[\s\S]*?<\/header\s*>/gi, "")
    .replace(/<footer\b[^>]*\shidden(?:\s|=|>)[^>]*>[\s\S]*?<\/footer\s*>/gi, "");
  const ids = new Set([...html.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)].map((match) => decodeHtml(match[2])));
  const references = [];
  for (const match of visibleHtml.matchAll(/\b(href|src|action|poster)\s*=\s*(["'])(.*?)\2/gi)) {
    references.push({ attribute: match[1].toLowerCase(), value: decodeHtml(match[3]) });
  }
  for (const match of visibleHtml.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    references.push({ attribute: "url()", value: decodeHtml(match[2].trim()) });
  }

  for (const reference of references) {
    const value = reference.value.trim();
    if (!value || /^(?:https?:|mailto:|tel:|javascript:|data:|blob:)/i.test(value)) continue;
    if (value === "#" || value.startsWith("#")) {
      if (value === "#" || !ids.has(decodeURIComponent(value.slice(1)))) {
        errors.push(`${relativePath}: dead fragment link ${value}`);
      }
      continue;
    }
    let resolved;
    try {
      resolved = resolveInternal(value, currentUrl);
    } catch {
      errors.push(`${relativePath}: invalid URL ${value}`);
      continue;
    }
    if (!resolved) {
      errors.push(`${relativePath}: path escapes the site root: ${value}`);
      continue;
    }
    if (!resolved.file) {
      errors.push(`${relativePath}: missing ${reference.attribute} target ${value}`);
    } else if (resolved.hash) {
      const targetHtml = resolved.file === file.absolutePath ? html : fs.readFileSync(resolved.file, "utf8");
      const targetIds = new Set([...targetHtml.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)].map((match) => decodeHtml(match[2])));
      if (!targetIds.has(decodeURIComponent(resolved.hash))) errors.push(`${relativePath}: missing fragment target ${value}`);
    }
  }
}

function checkAccessibilityAndSeo(relativePath, html) {
  if (relativePath.startsWith(`admin${path.sep}`)) return;
  for (const [tag, className] of [["header", "site-header"], ["main", "main-content"], ["footer", "site-footer"]]) {
    const count = [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "gi"))]
      .filter((match) => !/(?:^|\s)hidden(?:\s|=|$)/i.test(match[1]))
      .filter((match) => match[1].includes(className) || (tag === "main" && /\bid\s*=\s*(["'])main-content\1/i.test(match[1]))).length;
    if (count !== 1) errors.push(`${relativePath}: expected one shared ${tag} landmark`);
  }
  if (/<img\b(?![^>]*\balt\s*=)[^>]*>/i.test(html)) errors.push(`${relativePath}: image is missing alt text`);
  if (/<a\b[^>]*\btarget\s*=\s*(["'])_blank\1(?![^>]*\brel\s*=\s*(["'])[^"']*(?:noopener|noreferrer)[^"']*\2)[^>]*>/i.test(html)) {
    errors.push(`${relativePath}: external target=_blank link lacks rel=noopener noreferrer`);
  }
  const ids = [...html.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]);
  if (new Set(ids).size !== ids.length) errors.push(`${relativePath}: duplicate id attributes`);
  const title = decodeHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "");
  const descriptionTag = html.match(/<meta\b(?=[^>]*\bname\s*=\s*(["'])description\1)[^>]*>/i)?.[0] || "";
  const description = decodeHtml(descriptionTag.match(/\bcontent\s*=\s*(["'])(.*?)\1/i)?.[2] || "");
  if (!title || title.length > 60) errors.push(`${relativePath}: missing or overly long title`);
  if (!description || description.length > 160) errors.push(`${relativePath}: missing or invalid meta description`);
  for (const attribute of ['property="og:title"', 'property="og:description"', 'name="twitter:card"', 'name="twitter:title"', 'name="twitter:description"']) {
    if (!html.includes(attribute)) errors.push(`${relativePath}: missing ${attribute}`);
  }
  if (!/<link\b[^>]*\brel\s*=\s*(["'])canonical\1/i.test(html)) errors.push(`${relativePath}: missing canonical URL`);
  if (!html.includes('id="cookieNotice"')) errors.push(`${relativePath}: missing cookie notice`);
}

if (!fs.existsSync(DIST)) throw new Error("Run npm run build before checking the generated site.");
for (const file of walk(DIST)) {
  const html = fs.readFileSync(file.absolutePath, "utf8");
  htmlFiles.push({ ...file, html });
  const label = file.relativePath.split(path.sep).join("/");
  checkTagNesting(html, label);
  checkLinks(file.absolutePath, file.relativePath, html);
  checkAccessibilityAndSeo(file.relativePath, html);
  if (!/<html\b[^>]*>/i.test(html) || !/<head\b[^>]*>/i.test(html) || !/<body\b[^>]*>/i.test(html)) {
    errors.push(`${label}: missing html/head/body document structure`);
  }
  if (!/^<!doctype html>/i.test(html.trimStart())) errors.push(`${label}: missing HTML5 doctype`);
}

const sitemap = fs.readFileSync(path.join(DIST, "sitemap.xml"), "utf8");
if (/resource\d+\.html|resources\d+\.html|\/admin(?:\/|<)/i.test(sitemap)) errors.push("Sitemap contains a redirect stub or admin URL.");
if (errors.length) {
  console.error(`${errors.length} site check(s) failed:`);
  console.error(errors.slice(0, 100).map((error) => `- ${error}`).join("\n"));
  if (errors.length > 100) console.error(`... and ${errors.length - 100} more`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${htmlFiles.length} generated HTML documents: links, landmarks, metadata, accessibility, and tag nesting passed.`);
}
