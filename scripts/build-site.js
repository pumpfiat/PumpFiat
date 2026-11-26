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
  const existing = cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const label = (existing || humanizedPath(relativePath))
    .replace(/^\s*Pumpfiat\s*(?:\||–|-|:)\s*/i, "")
    .replace(/\s*(?:\||–|-|:)\s*Pumpfiat\s*$/i, "")
    .trim() || humanizedPath(relativePath);
  const suffix = " | Pumpfiat";
  const title = `${label.slice(0, 60 - suffix.length).trim()}${suffix}`;
  return title.length <= 60 ? title : `${humanizedPath(relativePath).slice(0, 60 - suffix.length).trim()}${suffix}`;
}

function seoDescription(html, title) {
  const existing = html.match(/<meta\b(?=[^>]*\bname\s*=\s*(["'])description\1)[^>]*\bcontent\s*=\s*(["'])(.*?)\2[^>]*>/i)?.[3];
  const firstHeading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const firstParagraph = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  let description = cleanText(existing || firstParagraph || firstHeading || title);
  description = description.replace(/\bPumpFiat\b/gi, "Pumpfiat").replace(/\bPUMPFIAT\b/g, "Pumpfiat");
  if (description.length > 160) description = `${description.slice(0, 157).trimEnd()}...`;
  return description;
}

function upsertSeo(html, relativePath) {
  html = html.replace(/\bPumpFiat\b/g, "Pumpfiat").replace(/\bPUMPFIAT\b/g, "Pumpfiat");
  const url = `${ORIGIN}${pageUrl(relativePath)}`;
  const title = seoTitle(html, relativePath);
  const description = seoDescription(html, title);
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
  if (url === "/" || url === "/index.html") return "SOLUTIONS";
  if (url.startsWith("/career/")) return "CAREERS";
  if (url === "/about.html") return "ABOUT";
  if (url === "/resources.html" || /\/(?:b2b-lead-generation|best-countries-to-hire-remote-sales-representatives|best-sdr-tools-and-software|cold-email-for-b2b-sales|hire-sales-development-representatives-globally|how-much-does-it-cost-to-hire-an-sdr|how-to-hire-a-remote-sdr|in-house-sdrs-vs-outsourced-sales-development|sales-development-vs-business-development|sdr-kpis-and-metrics)\/?$/.test(url)) return "RESOURCES";
  if (/(?:compliance|ethical-use|permission-verified|responsible-b2b|dataanalysis)/i.test(url)) return "TRUST";
  if (/\.(?:html)$/.test(url) || url.includes("/opportunities/")) return "SOLUTIONS";
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
  for (const section of ["SOLUTIONS", "TRUST", "ABOUT", "RESOURCES", "CAREERS"]) {
    html = html.replaceAll(`{{ACTIVE_${section}}}`, active === section ? ' aria-current="page"' : "");
  }
  return html;
}

function addHiddenAttribute(tag) {
  const attributes = tag.replace(/\bclass\s*=\s*(["'])[\s\S]*?\1/i, "");
  return /(?:^|\s)hidden(?:\s|=|>)/i.test(attributes) ? tag : tag.replace(/>$/, " hidden>");
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

function injectShell(html, relativePath, templates) {
  const header = renderHeader(templates.header, relativePath, html);
  html = html.replace(/<header\b[^>]*>/gi, addHiddenAttribute);
  const footerTags = [...html.matchAll(/<footer\b[^>]*>/gi)];
  if (footerTags.length) {
    const last = footerTags.at(-1);
    const hiddenTag = addHiddenAttribute(last[0]);
    html = `${html.slice(0, last.index)}${hiddenTag}${html.slice(last.index + last[0].length)}`;
  }

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
  return addMissingAlt(secureExternalLinks(html));
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
  const sitemapEntries = [];

  for (const file of pages) {
    const source = fs.readFileSync(file.absolutePath, "utf8");
    let html = upsertSeo(source, file.relativePath);
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
  fs.writeFileSync(path.join(DIST, "sitemap.xml"), sitemapXml(sitemapEntries));
  fs.writeFileSync(path.join(DIST, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  console.log(`Built ${pages.length} public HTML files into ${path.relative(ROOT, DIST)}; sitemap contains ${sitemapEntries.length} URLs.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildSite();
}
