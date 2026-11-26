import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const ORIGIN = (process.env.PUMPFIAT_PUBLIC_URL || "https://pumpfiat.com").replace(/\/+$/, "");
const PUBLIC_EXTENSIONS = new Set([
  ".avif", ".css", ".gif", ".ico", ".jpeg", ".jpg", ".js", ".json", ".mp4",
  ".pdf", ".png", ".svg", ".txt", ".webp", ".woff", ".woff2", ".xml",
]);
const EXCLUDED_FILES = new Set([
  ".ds_store",
  ".env.example",
  ".gitignore",
  "hometest.html",
  "originalindex.html",
  "package.json",
  "pumpfiat-osof-content-campaign-improved.html",
  "readme.md",
  "server.js",
  "test.htm",
  "testgrok.html",
]);
const EXCLUDED_DIRS = new Set([".git", "admin", "data", "dist", "node_modules", "partials", "scripts", "tests", "__MACOSX"]);

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanText(value) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function pageUrl(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized === "index.html") return "/";
  if (normalized.endsWith("/index.html")) return `/${normalized.slice(0, -"index.html".length)}`;
  return `/${normalized}`;
}

function isRedirectStub(relativePath) {
  const basename = path.basename(relativePath).toLowerCase();
  return /^(?:resource\d+|resources\d+)\.html$/.test(basename);
}

function isExcluded(relativePath) {
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true;
  if (parts.includes("placeholders")) return true;
  if (EXCLUDED_FILES.has(path.basename(relativePath).toLowerCase())) return true;
  if (/\.(?:htm|ds_store)$/i.test(relativePath)) return true;
  if (isRedirectStub(relativePath)) return true;
  return false;
}

function walk(directory, relativeDirectory = "") {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (isExcluded(relativePath)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(absolutePath, relativePath));
    else if (entry.isFile()) found.push({ absolutePath, relativePath });
  }
  return found;
}

function setMeta(html, attribute, name, content) {
  const matcher = new RegExp(`\\b${attribute}\\s*=\\s*(["'])${escapeRegExp(name)}\\1`, "i");
  let replaced = false;
  const tag = `<meta ${attribute}="${escapeHtml(name)}" content="${escapeHtml(content)}">`;
  html = html.replace(/<meta\b[^>]*>/gi, (existing) => {
    if (replaced || !matcher.test(existing)) return existing;
    replaced = true;
    return tag;
  });
  return replaced ? html : html.replace(/<\/head\s*>/i, `  ${tag}\n</head>`);
}

function setCanonical(html, href) {
  let replaced = false;
  const tag = `<link rel="canonical" href="${escapeHtml(href)}">`;
  html = html.replace(/<link\b[^>]*>/gi, (existing) => {
    if (replaced || !/\brel\s*=\s*(["'])canonical\1/i.test(existing)) return existing;
    replaced = true;
    return tag;
  });
  return replaced ? html : html.replace(/<\/head\s*>/i, `  ${tag}\n</head>`);
}

function humanizedPath(relativePath) {
  if (relativePath === "index.html") return "Permission-based B2B Outreach";
  const segments = relativePath.replace(/(?:^|\/)index\.html$/i, "").replace(/\.html$/i, "").split("/");
  return segments.at(-1).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function seoTitle(html, relativePath) {
  if (relativePath === "index.html") return "Permission-Based B2B Outreach | Pumpfiat";
  const existing = cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const label = (existing || humanizedPath(relativePath))
    .replace(/^\s*Pumpfiat\s*(?:\||–|—|-|:)\s*/i, "")
    .replace(/\s*(?:\||–|—|-|:)\s*Pumpfiat\s*$/i, "")
    .trim() || humanizedPath(relativePath);
  const suffix = " | Pumpfiat";
  const title = `${label.slice(0, 60 - suffix.length).trim()}${suffix}`;
  return title.length <= 60 ? title : `${humanizedPath(relativePath).slice(0, 60 - suffix.length).trim()}${suffix}`;
}

function seoDescription(html, title, relativePath) {
  if (relativePath === "index.html") {
    return "Pumpfiat helps B2B teams find relevant prospects and run compliant outreach with research-led data and audit-ready workflows.";
  }
  const existing = html.match(/<meta\b(?=[^>]*\bname\s*=\s*(["'])description\1)[^>]*\bcontent\s*=\s*(["'])(.*?)\2[^>]*>/i)?.[3];
  const firstHeading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const firstParagraph = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  let description = cleanText(existing || firstParagraph || firstHeading || title);
  description = description.replace(/\bPumpFiat\b/gi, "Pumpfiat").replace(/\bPUMPFIAT\b/g, "Pumpfiat");
  if (description.length > 160) description = `${description.slice(0, 157).trimEnd()}...`;
  return description;
}

function upsertSeo(html, relativePath, usedTitles, usedDescriptions) {
  html = html.replace(/\bPumpFiat\b/g, "Pumpfiat").replace(/\bPUMPFIAT\b/g, "Pumpfiat");
  const url = `${ORIGIN}${pageUrl(relativePath)}`;
  let title = seoTitle(html, relativePath);
  if (usedTitles.has(title)) {
    const suffix = ` — ${humanizedPath(relativePath)}`;
    title = `${title.slice(0, Math.max(1, 60 - suffix.length)).trimEnd()}${suffix}`;
  }
  usedTitles.add(title);
  let description = seoDescription(html, title, relativePath);
  if (usedDescriptions.has(description)) {
    const suffix = ` (${humanizedPath(relativePath)})`;
    description = `${description.slice(0, Math.max(0, 160 - suffix.length)).trimEnd()}${suffix}`;
  }
  usedDescriptions.add(description);
  html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  if (!/<title\b/i.test(html)) html = html.replace(/<\/head\s*>/i, `  <title>${escapeHtml(title)}</title>\n</head>`);
  html = setMeta(html, "name", "description", description);
  html = setMeta(html, "property", "og:title", title);
  html = setMeta(html, "property", "og:description", description);
  html = setMeta(html, "property", "og:url", url);
  html = setMeta(html, "property", "og:type", "website");
  html = setMeta(html, "property", "og:image", `${ORIGIN}/assets/logo.png`);
  html = setMeta(html, "name", "twitter:card", "summary");
  html = setMeta(html, "name", "twitter:title", title);
  html = setMeta(html, "name", "twitter:description", description);
  html = setMeta(html, "name", "twitter:image", `${ORIGIN}/assets/logo.png`);
  html = setCanonical(html, url);
  return html;
}

function currentSection(url) {
  if (url === "/" || url === "/index.html") return "";
  if (url.startsWith("/career/")) return "CAREERS";
  if (url.startsWith("/opportunities/")) return "OPPORTUNITIES";
  if (url === "/about.html") return "ABOUT";
  if (url === "/resources.html" || /\/(?:b2b-lead-generation|best-countries-to-hire-remote-sales-representatives|best-sdr-tools-and-software|cold-email-for-b2b-sales|hire-sales-development-representatives-globally|how-much-does-it-cost-to-hire-an-sdr|how-to-hire-a-remote-sdr|in-house-sdrs-vs-outsourced-sales-development|sales-development-vs-business-development|sdr-kpis-and-metrics)\/?$/.test(url)) return "RESOURCES";
  if (/(?:compliance|ethical-use|permission-verified|responsible-b2b|dataanalysis)/i.test(url)) return "TRUST";
  return "";
}

function renderHeader(headerTemplate, relativePath, source) {
  const url = pageUrl(relativePath);
  const active = currentSection(url);
  let ctaText = "Request an audit";
  let ctaHref = "/onboarding.html";
  if (/^\/opportunities\/osof-no-code-(?:affiliate|referral)-campaign\//.test(url) && /id=["']registration["']/.test(source)) {
    ctaText = "Join the campaign";
    ctaHref = "#registration";
  } else if (url.startsWith("/opportunities/")) {
    ctaText = "Explore opportunities";
    ctaHref = "/opportunities/";
  }
  let html = headerTemplate.replaceAll("{{CTA_TEXT}}", ctaText).replaceAll("{{CTA_HREF}}", ctaHref);
  for (const section of ["TRUST", "ABOUT", "RESOURCES", "CAREERS", "OPPORTUNITIES"]) {
    html = html.replaceAll(`{{ACTIVE_${section}}}`, active === section ? ' aria-current="location"' : "");
  }
  return html;
}

function secureExternalLinks(html) {
  return html.replace(/<a\b[^>]*\btarget\s*=\s*(["'])_blank\1[^>]*>/gi, (tag) => {
    const relMatch = tag.match(/\brel\s*=\s*(["'])(.*?)\1/i);
    if (!relMatch) return tag.replace(/>$/, ' rel="noopener noreferrer">');
    const relTokens = new Set(relMatch[2].split(/\s+/).filter(Boolean));
    relTokens.add("noopener");
    relTokens.add("noreferrer");
    return tag.replace(relMatch[0], `rel="${[...relTokens].join(" ")}"`);
  });
}

function addMissingAlt(html) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => /\balt\s*=/i.test(tag) ? tag : tag.replace(/>$/, ' alt="">'));
}

export function imageDimensions(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png" && data.length >= 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (extension === ".gif" && data.length >= 10) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (extension === ".webp" && data.length >= 30) {
    const chunk = data.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
    }
    if (chunk === "VP8L" && data[20] === 0x2f) {
      const b1 = data[21], b2 = data[22], b3 = data[23], b4 = data[24];
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      };
    }
    if (chunk === "VP8 " && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
  }
  if (extension === ".svg") {
    const svg = data.toString("utf8");
    const viewBox = svg.match(/\bviewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
    if (viewBox) return { width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) };
    const width = svg.match(/\bwidth=["']([\d.]+)/i), height = svg.match(/\bheight=["']([\d.]+)/i);
    if (width && height) return { width: Math.round(Number(width[1])), height: Math.round(Number(height[1])) };
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      }
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return null;
}

function webpSrcset(sourcePath, nativeWidth) {
  const base = sourcePath.replace(/\.(?:png|jpe?g)$/i, "");
  const candidates = [];
  for (const width of [480, 960, 1440]) {
    const candidatePath = `${base}.${width}.webp`;
    if (fs.existsSync(path.join(ROOT, candidatePath))) candidates.push({ path: candidatePath, width });
  }
  const nativePath = `${base}.webp`;
  if (nativeWidth && fs.existsSync(path.join(ROOT, nativePath))) candidates.push({ path: nativePath, width: nativeWidth });
  return candidates;
}

function optimizePageImages(html, relativePath) {
  let imageIndex = 0;
  const withResponsiveImages = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!src || /^(?:https?:|data:|blob:)/i.test(src)) return tag;
    let sourcePath;
    try {
      const url = new URL(src, `https://pumpfiat.local${pageUrl(relativePath)}`);
      sourcePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch {
      return tag;
    }
    const absolutePath = path.resolve(ROOT, sourcePath);
    if (!absolutePath.startsWith(`${ROOT}${path.sep}`)) return tag;
    const dimensions = imageDimensions(absolutePath);
    if (dimensions) {
      if (!/\bwidth\s*=/i.test(tag)) tag = tag.replace(/>$/, ` width="${dimensions.width}">`);
      if (!/\bheight\s*=/i.test(tag)) tag = tag.replace(/>$/, ` height="${dimensions.height}">`);
    }
    const isBrandLogo = sourcePath === "assets/logo.png";
    if (!/\bloading\s*=/i.test(tag)) tag = tag.replace(/>$/, ` loading="${isBrandLogo || imageIndex === 0 ? "eager" : "lazy"}">`);
    if (!isBrandLogo && imageIndex === 0 && !/\bfetchpriority\s*=/i.test(tag)) tag = tag.replace(/>$/, ' fetchpriority="high">');
    if (!isBrandLogo) imageIndex += 1;
    if (!/\.(?:png|jpe?g)$/i.test(sourcePath) || /<picture\b/i.test(tag)) return tag;
    const candidates = webpSrcset(sourcePath, dimensions?.width);
    if (!candidates.length) return tag;
    const srcset = candidates.map(({ path: candidate, width }) => `${encodeURI(`/${candidate}`)} ${width}w`).join(", ");
    const sizes = tag.match(/\bsizes\s*=\s*(["'])(.*?)\1/i)?.[0] || 'sizes="(max-width: 48rem) 100vw, 48rem"';
    const source = `<source type="image/webp" srcset="${srcset}" ${sizes}>`;
    return `<picture>${source}${tag}</picture>`;
  });
  return withResponsiveImages.replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi, (attribute, quote, style) => {
    const optimizedStyle = style.replace(/background-image\s*:\s*([^;]+);?/gi, (declaration, value) => {
      let changed = false;
      const optimizedValue = value.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (url, _quote, src) => {
        let sourcePath;
        try {
          const parsed = new URL(src, `https://pumpfiat.local${pageUrl(relativePath)}`);
          sourcePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
        } catch {
          return url;
        }
        if (!/\.(?:png|jpe?g)$/i.test(sourcePath)) return url;
        const absolutePath = path.resolve(ROOT, sourcePath);
        const dimensions = imageDimensions(absolutePath);
        const candidates = dimensions && webpSrcset(sourcePath, dimensions.width);
        if (!candidates?.length) return url;
        changed = true;
        const densityCandidates = candidates
          .filter(({ width }) => width >= 480)
          .slice(0, 2)
          .map(({ path: candidate }, index) => `url(${encodeURI(`/${candidate}`)}) ${index + 1}x`);
        return densityCandidates.length ? `image-set(${densityCandidates.join(", ")})` : url;
      });
      const fallbackDeclaration = declaration.replace(/;\s*$/, "");
      return changed ? `${fallbackDeclaration}; background-image: ${optimizedValue};` : declaration;
    });
    return `style=${quote}${optimizedStyle}${quote}`;
  });
}

function removeElementsById(html, targetIds) {
  for (const id of targetIds) {
    const openingTag = new RegExp(`<([a-z][a-z0-9:-]*)\\b(?=[^>]*\\bid\\s*=\\s*(["'])${escapeRegExp(id)}\\2)[^>]*>`, "i");
    let match;
    while ((match = openingTag.exec(html))) {
      const tagName = match[1];
      const tokens = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
      tokens.lastIndex = match.index;
      let depth = 0;
      let end = -1;
      let token;
      while ((token = tokens.exec(html))) {
        if (/^<\//.test(token[0])) depth -= 1;
        else if (!/\/\s*>$/.test(token[0])) depth += 1;
        if (depth === 0) {
          end = tokens.lastIndex;
          break;
        }
      }
      if (end < 0) throw new Error(`Unclosed legacy navigation element #${id}`);
      html = `${html.slice(0, match.index)}${html.slice(end)}`;
    }
  }
  return html;
}

function normalizedUrlPath(value) {
  const pathname = new URL(value, "https://pumpfiat.local/resources.html").pathname;
  return decodeURIComponent(pathname).replace(/\/+$/, "") || "/";
}

function resourceTokens(value) {
  const ignored = new Set(["about", "after", "also", "and", "are", "best", "building", "from", "guide", "how", "into", "more", "that", "the", "their", "this", "through", "with", "your"]);
  return new Set((value.toLowerCase().match(/[a-z0-9]+/g) || []).filter((word) => word.length > 2 && !ignored.has(word)));
}

function readResourceCatalog(resourcesHtml, pages) {
  const pageByUrl = new Map(pages.map((file) => [normalizedUrlPath(pageUrl(file.relativePath)), file]));
  const catalog = [];
  const cards = resourcesHtml.match(/<a\b[^>]*\bclass\s*=\s*["'][^"']*\bresource-card\b[^"']*["'][^>]*>[\s\S]*?<\/a\s*>/gi) || [];

  for (const card of cards) {
    const href = card.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    const title = cleanText(card.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || "");
    if (!href || !title) throw new Error("resources.html has a resource card without a link or title.");

    const file = pageByUrl.get(normalizedUrlPath(href));
    if (!file) throw new Error(`resources.html links to a missing article: ${href}`);

    const tags = (card.match(/\bdata-tags\s*=\s*(["'])(.*?)\1/i)?.[2] || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((tag) => tag.toLowerCase());
    const category = cleanText(card.match(/<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1] || tags[0] || "Resource");
    const source = fs.readFileSync(file.absolutePath, "utf8");
    catalog.push({
      url: normalizedUrlPath(pageUrl(file.relativePath)),
      href: pageUrl(file.relativePath),
      title,
      category,
      tags,
      summary: seoDescription(source, title, file.relativePath),
      tokens: resourceTokens(`${title} ${category} ${tags.join(" ")}`),
    });
  }

  if (catalog.length < 4) throw new Error("resources.html must list at least four articles to generate Keep Learning recommendations.");
  return catalog;
}

function renderKeepLearning(currentUrl, catalog) {
  const current = catalog.find((resource) => resource.url === currentUrl);
  if (!current) return "";

  const recommendations = catalog
    .filter((resource) => resource.url !== currentUrl)
    .map((resource, index) => {
      const sharedTags = resource.tags.filter((tag) => current.tags.includes(tag)).length;
      const sharedTokens = [...resource.tokens].filter((token) => current.tokens.has(token)).length;
      const sameCategory = resource.category.toLowerCase() === current.category.toLowerCase();
      return { resource, index, score: (sameCategory ? 8 : 0) + sharedTags * 3 + sharedTokens };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map(({ resource }) => resource);

  if (recommendations.length !== 3) throw new Error(`Could not generate three Keep Learning recommendations for ${current.href}.`);

  const cards = recommendations.map((resource) => `
          <a data-keep-learning-card href="${escapeHtml(resource.href)}" class="rounded-xl bg-white/10 p-5 text-white no-underline backdrop-blur transition hover:bg-white/20">
            <div class="mb-2 text-xs uppercase text-white/80">${escapeHtml(resource.category)}</div>
            <h3 class="text-lg font-bold">${escapeHtml(resource.title)}</h3>
            <p class="mt-2 text-sm text-white/80">${escapeHtml(resource.summary)}</p>
          </a>`).join("");

  return `
      <section id="related" data-keep-learning class="not-prose mt-20 rounded-2xl bg-gradient-to-r from-[color:var(--color-accent)] to-[#00606b] p-8 text-white">
        <h2 class="mb-6 text-3xl font-extrabold">Keep Learning</h2>
        <div class="grid gap-6 md:grid-cols-3">${cards}
        </div>
        <div class="mt-8 text-center">
          <a href="/resources.html" class="inline-block rounded-xl border border-white/40 bg-[#004652] px-6 py-3 font-bold text-white no-underline transition hover:bg-[#003943]">Browse all resources</a>
        </div>
      </section>
  `;
}

function addDynamicKeepLearning(html, relativePath, catalog) {
  const currentUrl = normalizedUrlPath(pageUrl(relativePath));
  const section = renderKeepLearning(currentUrl, catalog);
  if (!section) return html;

  html = removeElementsById(html, ["related"]);
  html = html.replace(/(<a\b[^>]*\bhref\s*=\s*(["'])#related\2[^>]*>)[\s\S]*?(<\/a\s*>)/gi, "$1Keep Learning$3");
  const closingArticle = html.toLowerCase().lastIndexOf("</article>");
  if (closingArticle < 0) throw new Error(`${relativePath}: resource article has no closing </article> tag.`);
  return `${html.slice(0, closingArticle)}${section}\n${html.slice(closingArticle)}`;
}

function stripLegacyMenuScripts(html) {
  return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag, attributes, code) => {
    if (!/mobileMenuBtn|mobileMenuToggle|mobile-menu-btn/.test(code)) return tag;
    if (/mobileMenuToggle/.test(code)) {
      const withoutToggle = code.replace(
        /const mobileMenuToggle\s*=\s*document\.getElementById\(["']mobileMenuToggle["']\);[\s\S]*?mobileMenu\.querySelectorAll\(["']a["']\)\.forEach\(link=>link\.addEventListener\(["']click["'],\(\)=>\{[\s\S]*?\}\)\);\s*/i,
        "",
      );
      if (withoutToggle === code) throw new Error("Could not remove legacy campaign menu handler");
      return `<script${attributes}>${withoutToggle}</script>`;
    }
    return "";
  });
}

function injectShell(html, relativePath, templates) {
  const header = renderHeader(templates.header, relativePath, html);
  html = html
    .replace(/<header\b[^>]*>[\s\S]*?<\/header\s*>/gi, "")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer\s*>/gi, "");
  html = stripLegacyMenuScripts(removeElementsById(html, ["mobileMenu", "mobile-menu"]));

  const mainMatch = html.match(/<main\b[^>]*>/i);
  let mainId = "main-content";
  if (mainMatch) {
    const id = mainMatch[0].match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (id) mainId = id;
    else html = html.replace(mainMatch[0], mainMatch[0].replace(/>$/, ' id="main-content">'));
  }
  const existingSkip = html.match(/<a\b[^>]*class\s*=\s*(["'])[^"']*\bskip-link\b[^"']*\1[^>]*>[\s\S]*?<\/a>/i)?.[0] || "";
  if (existingSkip) html = html.replace(existingSkip, "");
  const skipLink = existingSkip || `<a class="skip-link" href="#${escapeHtml(mainId)}">Skip to content</a>`;
  const needsMain = !mainMatch;
  const bodyOpen = html.match(/<body\b[^>]*>/i);
  if (!bodyOpen) throw new Error(`${relativePath}: missing <body> element`);
  const mainOpen = needsMain ? '<main id="main-content">' : "";
  html = html.replace(bodyOpen[0], `${bodyOpen[0]}\n${skipLink}\n${header}${mainOpen}`);
  const closing = `${needsMain ? "</main>" : ""}\n${templates.cookieNotice}\n${templates.footer}\n<script src="/assets/site-shell.js" defer></script>\n</body>`;
  html = html.replace(/<\/body\s*>/i, closing);
  html = html.replace(/<link\b[^>]*href\s*=\s*(["'])\/assets\/site-shell\.css\1[^>]*>/gi, "");
  html = html.replace(/<\/head\s*>/i, '  <link rel="stylesheet" href="/assets/site-shell.css">\n</head>');
  return optimizePageImages(addMissingAlt(secureExternalLinks(html)), relativePath);
}

function copyStaticFiles(files) {
  for (const file of files) {
    if (/\.html$/i.test(file.relativePath)) continue;
    const extension = path.extname(file.relativePath).toLowerCase();
    if (!PUBLIC_EXTENSIONS.has(extension)) continue;
    const destination = path.join(DIST, file.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.absolutePath, destination);
  }
}

function sitemapXml(entries) {
  const urls = entries.map(({ url, lastmod }) =>
    `  <url>\n    <loc>${escapeHtml(`${ORIGIN}${url}`)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export async function buildSite() {
  if (path.basename(DIST) !== "dist" || path.dirname(DIST) !== ROOT) throw new Error("Refusing to build outside the project dist directory");
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  const templates = {
    header: fs.readFileSync(path.join(ROOT, "partials/site-header.html"), "utf8").trim(),
    footer: fs.readFileSync(path.join(ROOT, "partials/site-footer.html"), "utf8").trim(),
    cookieNotice: fs.readFileSync(path.join(ROOT, "partials/cookie-notice.html"), "utf8").trim(),
  };
  const files = walk(ROOT);
  copyStaticFiles(files);
  const pages = files.filter(({ relativePath }) => /\.html$/i.test(relativePath));
  const resourcesPage = pages.find(({ relativePath }) => relativePath.split(path.sep).join("/") === "resources.html");
  if (!resourcesPage) throw new Error("resources.html is required to generate resource recommendations.");
  const resourceCatalog = readResourceCatalog(fs.readFileSync(resourcesPage.absolutePath, "utf8"), pages);
  const sitemapEntries = [];
  const usedTitles = new Set();
  const usedDescriptions = new Set();

  for (const file of pages) {
    const source = fs.readFileSync(file.absolutePath, "utf8");
    let html = addDynamicKeepLearning(source, file.relativePath, resourceCatalog);
    html = upsertSeo(html, file.relativePath, usedTitles, usedDescriptions);
    html = injectShell(html, file.relativePath, templates);
    const destination = path.join(DIST, file.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, html);

    const url = pageUrl(file.relativePath);
    const excludedFromIndex = url === "/404.html" || /\/admin(?:\/|$)/.test(url) || /name=["']robots["'][^>]*noindex/i.test(html);
    if (!excludedFromIndex) {
      const lastmod = fs.statSync(file.absolutePath).mtime.toISOString().slice(0, 10);
      sitemapEntries.push({ url, lastmod });
    }
  }

  const adminSource = path.join(ROOT, "admin/index.html");
  if (fs.existsSync(adminSource)) {
    let adminHtml = fs.readFileSync(adminSource, "utf8").replace(/\bPumpFiat\b/g, "Pumpfiat").replace(/\bPUMPFIAT\b/g, "Pumpfiat");
    if (!/name=["']robots["']/i.test(adminHtml)) {
      adminHtml = adminHtml.replace(/<\/head\s*>/i, '  <meta name="robots" content="noindex,nofollow">\n</head>');
    }
    const adminDestination = path.join(DIST, "admin/index.html");
    fs.mkdirSync(path.dirname(adminDestination), { recursive: true });
    fs.writeFileSync(adminDestination, adminHtml);
  }

  sitemapEntries.sort((a, b) => a.url.localeCompare(b.url));
  const sitemap = sitemapXml(sitemapEntries);
  const robots = `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${ORIGIN}/sitemap.xml\n`;
  fs.writeFileSync(path.join(DIST, "sitemap.xml"), sitemap);
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);
  fs.writeFileSync(path.join(DIST, "robots.txt"), robots);
  fs.writeFileSync(path.join(ROOT, "robots.txt"), robots);
  console.log(`Built ${pages.length} public HTML files into ${path.relative(ROOT, DIST)}; sitemap contains ${sitemapEntries.length} URLs.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildSite();
}
