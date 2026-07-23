#!/usr/bin/env node

import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const publicDirectory = path.join(projectRoot, "public-site");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "downloads") files.push(...await walk(absolute));
    } else {
      files.push(absolute);
    }
  }
  return files;
}

function localTarget(reference, sourceFile) {
  if (!reference || reference.startsWith("#") || /^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(reference)) return null;
  const parsed = new URL(reference, "https://olive-remote-lab.web.app/");
  if (parsed.origin !== "https://olive-remote-lab.web.app") return null;
  if (parsed.pathname.startsWith("/api/")) return null;

  let pathname = reference.startsWith("/")
    ? parsed.pathname.slice(1)
    : path.relative(publicDirectory, path.resolve(path.dirname(sourceFile), parsed.pathname.split("/").at(-1) || "index.html"));
  if (!pathname) pathname = "index.html";
  if (!path.extname(pathname)) pathname = `${pathname}.html`;
  return { file: path.join(publicDirectory, pathname), fragment: parsed.hash.slice(1) };
}

function idsIn(html) {
  return [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
}

async function validateHtml(filename, allHtml) {
  const relative = path.relative(projectRoot, filename);
  const html = allHtml.get(filename);
  const ids = idsIn(html);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length) throw new Error(`${relative}: duplicate ids: ${[...new Set(duplicateIds)].join(", ")}`);

  for (const match of html.matchAll(/<(?:a|link|script|img)\b[^>]*?\s(?:href|src)=["']([^"']+)["']/gi)) {
    const reference = match[1];
    if (reference.startsWith("#")) {
      const id = reference.slice(1);
      if (id && !ids.includes(id)) throw new Error(`${relative}: missing local fragment #${id}`);
      continue;
    }
    const target = localTarget(reference, filename);
    if (!target) continue;
    try {
      await access(target.file);
    } catch {
      throw new Error(`${relative}: missing local asset ${reference}`);
    }
    if (target.fragment) {
      const targetHtml = allHtml.get(target.file) ?? await readFile(target.file, "utf8");
      if (!idsIn(targetHtml).includes(target.fragment)) throw new Error(`${relative}: ${reference} points to a missing fragment`);
    }
  }

  for (const match of html.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      JSON.parse(match[1]);
    } catch (error) {
      throw new Error(`${relative}: invalid JSON-LD: ${error.message}`);
    }
  }

  const prohibitedClaims = [
    /fully supports every olive/i,
    /works with every olive/i,
    /olive one (?:is )?supported/i,
    /guaranteed (?:disk |library )?recovery/i,
  ];
  for (const claim of prohibitedClaims) {
    if (claim.test(html)) throw new Error(`${relative}: prohibited compatibility/recovery claim matched ${claim}`);
  }
}

async function main() {
  const files = await walk(publicDirectory);
  const htmlFiles = files.filter((filename) => filename.endsWith(".html"));
  const allHtml = new Map(await Promise.all(htmlFiles.map(async (filename) => [filename, await readFile(filename, "utf8")])));
  await Promise.all(htmlFiles.map((filename) => validateHtml(filename, allHtml)));

  const diagnostic = allHtml.get(path.join(publicDirectory, "diagnostic.html"));
  const diagnosticFields = new Set([...diagnostic.matchAll(/\sname=["']([^"']+)["']/g)].map((match) => match[1]));
  const requiredFields = ["startedAt", "source", "website", "model", "firmware", "bootState", "networkVisibility", "issue", "country", "email", "details", "consent", "releaseConsent"];
  for (const field of requiredFields) {
    if (!diagnosticFields.has(field)) throw new Error(`public-site/diagnostic.html: missing field ${field}`);
  }

  const sitemap = await readFile(path.join(publicDirectory, "sitemap.xml"), "utf8");
  for (const match of sitemap.matchAll(/<loc>https:\/\/olive-remote-lab\.web\.app(.*?)<\/loc>/g)) {
    const target = localTarget(match[1] || "/", path.join(publicDirectory, "index.html"));
    if (!target) continue;
    try {
      await access(target.file);
    } catch {
      throw new Error(`public-site/sitemap.xml: missing page for ${match[1] || "/"}`);
    }
  }

  process.stdout.write(`Validated ${htmlFiles.length} HTML pages, local links, fragments, JSON-LD, diagnostic fields, and sitemap routes.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
