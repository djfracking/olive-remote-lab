#!/usr/bin/env node

/**
 * Builds a privacy-safe Olive owner-intelligence snapshot.
 *
 * Default mode only compiles the reviewed local inventory. `--network` adds
 * sanctioned Common Crawl URL-index records and, when OLIVE_YOUTUBE_API_KEY is
 * present, public YouTube video metadata. It never logs in, posts, scrapes
 * people/profile pages, bypasses bot challenges, or creates contact lists.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const researchDirectory = path.join(projectRoot, 'research', 'owner-intelligence');
const outputDirectory = path.join(researchDirectory, 'output');

const flags = new Set(process.argv.slice(2));
const networkEnabled = flags.has('--network');
const helpRequested = flags.has('--help') || flags.has('-h');

const USER_AGENT = 'OliveRemotePublicResearch/1.0 (+https://olive-remote-lab.web.app/privacy; metadata-only)';
const REQUIRED_SOURCE_FIELDS = [
  'id',
  'priority',
  'category',
  'platform',
  'title',
  'url',
  'models',
  'issues',
  'language',
  'activity',
  'status',
  'access',
  'posting_route',
  'collection_policy',
  'notes',
];

const blockedArchivePathFragments = [
  '/account',
  '/accounts',
  '/admin',
  '/cart',
  '/career',
  '/carrieres',
  '/checkout',
  '/contact',
  '/customer_data',
  '/customer-data',
  '/email',
  '/login',
  '/management',
  '/member',
  '/members',
  '/myaccount',
  '/newsletter',
  '/password',
  '/presscontact',
  '/profile',
  '/register',
  '/signin',
  '/signup',
  '/subscribe',
  '/team',
  '/user/',
  '/users/',
  '/wp-admin',
  '/vacatures',
  '/karriere',
  '/emploi',
  '/empleo',
  '/lavora',
  '/jobs',
];

if (helpRequested) {
  process.stdout.write(`Usage: npm run research:owners -- [--network]\n\n`);
  process.stdout.write(`Default: compile the reviewed source inventory and report without network access.\n`);
  process.stdout.write(`--network: query the Common Crawl URL index. If OLIVE_YOUTUBE_API_KEY is set, also collect public video metadata.\n`);
  process.exit(0);
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const nextCharacter = input[index + 1];

    if (inQuotes) {
      if (character === '"' && nextCharacter === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (inQuotes) throw new Error('Malformed CSV: unterminated quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    if (row.some((value) => value.length > 0)) rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(
        `Malformed CSV row ${rowIndex + 2}: expected ${headers.length} fields, received ${values.length}`,
      );
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

async function readCsv(filename) {
  const content = await readFile(path.join(researchDirectory, filename), 'utf8');
  return parseCsv(content);
}

async function readOutputJsonLines(filename) {
  try {
    const content = await readFile(path.join(outputDirectory, filename), 'utf8');
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readPreviousSummary() {
  try {
    return JSON.parse(await readFile(path.join(outputDirectory, 'summary.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function mergeLatestRecords(previous, current, keyField, timestampField) {
  const records = new Map(previous.map((record) => [record[keyField], record]));
  for (const record of current) {
    const key = record[keyField];
    const existing = records.get(key);
    if (!existing || !timestampField || String(record[timestampField] ?? '') >= String(existing[timestampField] ?? '')) {
      records.set(key, record);
    }
  }
  return [...records.values()];
}

function canonicalizeHttpUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (
      key.toLowerCase().startsWith('utm_') ||
      ['fbclid', 'gclid', 'install', 'ref', 'source'].includes(key.toLowerCase())
    ) {
      parsed.searchParams.delete(key);
    }
  }
  if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

function validateAndNormalizeSources(sources) {
  const ids = new Set();
  const urls = new Set();

  return sources.map((source, sourceIndex) => {
    for (const field of REQUIRED_SOURCE_FIELDS) {
      if (!source[field]) throw new Error(`sources.csv row ${sourceIndex + 2} is missing ${field}`);
    }
    if (ids.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    ids.add(source.id);

    const canonicalUrl = canonicalizeHttpUrl(source.url);
    if (urls.has(canonicalUrl)) throw new Error(`Duplicate source URL: ${canonicalUrl}`);
    urls.add(canonicalUrl);

    const priority = Number.parseInt(source.priority, 10);
    if (![1, 2, 3].includes(priority)) throw new Error(`Invalid priority for ${source.id}`);

    const currentActivity = /202[4-6]/.test(source.activity);
    const openStatus = /(active|verify-open|verify-live)/.test(source.status);
    const rankScore =
      { 1: 100, 2: 70, 3: 40 }[priority] +
      (source.category === 'community' ? 10 : 0) +
      (currentActivity ? 15 : 0) +
      (openStatus ? 10 : 0);

    return {
      ...source,
      priority,
      url: canonicalUrl,
      models: source.models.split('|').filter(Boolean),
      issues: source.issues.split('|').filter(Boolean),
      rank_score: rankScore,
    };
  });
}

function validateSourceReferences(rows, field, knownSourceIds, filename) {
  for (const [rowIndex, row] of rows.entries()) {
    const references = (row[field] ?? '').split('|').filter(Boolean);
    if (references.length === 0) {
      throw new Error(`${filename} row ${rowIndex + 2} is missing ${field}`);
    }
    for (const reference of references) {
      if (!knownSourceIds.has(reference)) {
        throw new Error(`${filename} row ${rowIndex + 2} references unknown source id ${reference}`);
      }
    }
  }
}

function tally(items, accessor) {
  const counts = {};
  for (const item of items) {
    const values = accessor(item);
    for (const value of Array.isArray(values) ? values : [values]) {
      if (!value) continue;
      counts[value] = (counts[value] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchText(url, { attempts = 3, timeoutMs = 25_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/x-ndjson, application/json;q=0.9, text/plain;q=0.8', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(500 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function archiveUrlIsAllowed(rawUrl, expectedPattern) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const expectedHost = expectedPattern.split('/')[0].toLowerCase();
  const actualHost = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (actualHost !== expectedHost.replace(/^www\./, '')) return false;

  const lowerPath = decodeURIComponent(parsed.pathname).toLowerCase();
  if (blockedArchivePathFragments.some((fragment) => lowerPath.includes(fragment))) return false;
  return ![...parsed.searchParams.keys()].some((key) =>
    /(email|e-mail|password|token|session|user|member|account)/i.test(key),
  );
}

function classifyArchiveUrl(parsed) {
  const pathname = decodeURIComponent(parsed.pathname).toLowerCase();
  const segments = pathname.split('/').filter(Boolean);
  const possibleLocale = segments[0] ?? '';
  const locale = /^[a-z]{2}(?:-[a-z]{2})?$/.test(possibleLocale) ? possibleLocale : null;

  const classifications = [
    { page_type: 'channel_partner', use: 'former dealer and distributor partnership research', pattern: /(dealer|retailer|distributor|where.?to.?buy|store.?locator)/ },
    { page_type: 'owner_evidence', use: 'aggregate owner language and product expectation research', pattern: /(customer.?stor|customer.?quote|survey.?result|testimonial)/ },
    { page_type: 'firmware_or_recovery', use: 'provenance research only pending rights and malware review', pattern: /(firmware|recovery|swupgrade|software.?update|release.?note|reinstall)/ },
    { page_type: 'documentation', use: 'internal support indexing', pattern: /(manual|guide|datasheet|brochure|quick.?start|documentation|download)/ },
    { page_type: 'support', use: 'support vocabulary and troubleshooting corpus', pattern: /(support|faq|help|troubleshoot|knowledge.?base)/ },
    { page_type: 'press_or_review', use: 'historical audience and backlink research', pattern: /(press|review|coverage|award|news)/ },
    { page_type: 'product', use: 'model and feature history', pattern: /(product|olive2|olive3|olive4|olive6|o3hd|o4hd|o6hd|opus|musica|symphony|melody)/ },
    { page_type: 'technology', use: 'feature and integration history', pattern: /(technology|iphone|internet.?radio|maestro|multi.?room)/ },
    { page_type: 'corporate', use: 'historical company context', pattern: /(about|contact|company|career|legal|privacy)/ },
  ];
  const match = classifications.find((classification) => classification.pattern.test(pathname));
  return {
    page_type: match?.page_type ?? 'other',
    research_use: match?.use ?? 'manual relevance review',
    locale,
  };
}

function normalizeArchiveRecord(record, target) {
  if (!record.url || !archiveUrlIsAllowed(record.url, target.url_pattern)) return null;
  let canonicalUrl;
  let classification;
  try {
    const parsed = new URL(record.url);
    parsed.hash = '';
    parsed.search = '';
    canonicalUrl = parsed.toString();
    classification = classifyArchiveUrl(parsed);
    // Corporate staff, careers, and contact pages are not owner-intelligence
    // inputs. They are excluded even when they were once public.
    if (classification.page_type === 'corporate') return null;
  } catch {
    return null;
  }

  return {
    source: 'common_crawl',
    target_id: target.id,
    index: target.index_name,
    url: canonicalUrl,
    capture_timestamp: record.timestamp ?? null,
    status: Number(record.status) || null,
    mime: record.mime ?? record['mime-detected'] ?? null,
    digest: record.digest ?? null,
    warc_filename: record.filename ?? null,
    warc_offset: record.offset ? Number(record.offset) : null,
    warc_length: record.length ? Number(record.length) : null,
    purpose: target.purpose,
    ...classification,
  };
}

async function collectCommonCrawl(targets) {
  const recordsByUrl = new Map();
  const runs = [];

  for (const target of targets) {
    const endpoint = new URL(`https://index.commoncrawl.org/${target.index_name}-index`);
    endpoint.searchParams.set('url', target.url_pattern);
    endpoint.searchParams.set('output', 'json');
    endpoint.searchParams.set('filter', 'status:200');
    endpoint.searchParams.set('collapse', 'urlkey');

    try {
      const body = await fetchText(endpoint);
      let accepted = 0;
      let rejected = 0;
      for (const line of body.split('\n').filter(Boolean)) {
        let rawRecord;
        try {
          rawRecord = JSON.parse(line);
        } catch {
          rejected += 1;
          continue;
        }
        const record = normalizeArchiveRecord(rawRecord, target);
        if (!record) {
          rejected += 1;
          continue;
        }
        const existing = recordsByUrl.get(record.url);
        if (!existing || String(record.capture_timestamp) > String(existing.capture_timestamp)) {
          recordsByUrl.set(record.url, record);
        }
        accepted += 1;
      }
      runs.push({ target_id: target.id, ok: true, accepted, rejected });
    } catch (error) {
      runs.push({ target_id: target.id, ok: false, accepted: 0, rejected: 0, error: error.message });
    }
    await delay(400);
  }

  return {
    records: [...recordsByUrl.values()].sort((a, b) => a.url.localeCompare(b.url)),
    runs,
  };
}

async function collectYouTubeVideoMetadata(apiKey) {
  if (!apiKey) return { records: [], runs: [{ ok: false, skipped: true, reason: 'OLIVE_YOUTUBE_API_KEY not set' }] };

  const queries = [
    '"Olive 4HD"',
    '"Olive O3HD"',
    '"Olive O6HD"',
    '"Olive ONE" music player',
    '"Olive Musica" music server',
  ];
  const recordsById = new Map();
  const runs = [];

  for (const query of queries) {
    const endpoint = new URL('https://www.googleapis.com/youtube/v3/search');
    endpoint.searchParams.set('part', 'snippet');
    endpoint.searchParams.set('type', 'video');
    endpoint.searchParams.set('maxResults', '50');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('key', apiKey);

    try {
      const body = await fetchText(endpoint);
      const result = JSON.parse(body);
      let accepted = 0;
      for (const item of result.items ?? []) {
        const videoId = item.id?.videoId;
        if (!videoId || !item.snippet?.title) continue;
        const relevanceText = `${item.snippet.title} ${item.snippet.description ?? ''}`.toLowerCase();
        if (!/(olive).*(4hd|o4hd|3hd|o3hd|6hd|o6hd|one|musica|symphony|opus)|(4hd|o4hd|3hd|o3hd|6hd|o6hd).*(olive)/i.test(relevanceText)) continue;
        recordsById.set(videoId, {
          source: 'youtube_data_api',
          video_id: videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          title: item.snippet.title,
          published_at: item.snippet.publishedAt ?? null,
          channel_title: item.snippet.channelTitle ?? null,
          matched_query: query,
        });
        accepted += 1;
      }
      runs.push({ query, ok: true, accepted });
    } catch (error) {
      runs.push({ query, ok: false, accepted: 0, error: error.message });
    }
    await delay(400);
  }

  return {
    records: [...recordsById.values()].sort((a, b) => String(b.published_at).localeCompare(String(a.published_at))),
    runs,
  };
}

async function writeAtomic(filename, content) {
  await mkdir(outputDirectory, { recursive: true });
  const destination = path.join(outputDirectory, filename);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, destination);
}

function asJsonLines(records) {
  return records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '';
}

function topEntries(counts, limit = 12) {
  return Object.entries(counts).slice(0, limit);
}

function markdownTable(rows, headers) {
  const escapeCell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [
    `| ${headers.map((header) => escapeCell(header.label)).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${headers.map((header) => escapeCell(header.value(row))).join(' | ')} |`),
  ].join('\n');
}

function buildRunReport(summary, rankedSources) {
  const topTargets = rankedSources.filter((source) => source.priority === 1).slice(0, 15);
  const archiveRunRows = summary.providers.common_crawl.runs;
  const youtubeRunRows = summary.providers.youtube.runs;
  const issueRows = topEntries(summary.counts.issues, 15).map(([issue, count]) => ({ issue, count }));
  const archiveTypeRows = topEntries(summary.counts.archive_page_types, 12).map(([pageType, count]) => ({ pageType, count }));

  return `# Olive owner-intelligence run report

Generated: ${summary.generated_at}

This snapshot contains public page- and thread-level intelligence. It deliberately contains no emails, phone numbers, member lists, follower lists, exact personal locations, cross-platform identity links, or scraped owner profiles.

Provider data: ${summary.provider_data_mode === 'refreshed-and-merged' ? 'refreshed through sanctioned APIs and merged with the prior provider snapshot.' : 'preserved from the prior network snapshot; no provider request was made in this offline run.'}

## Result

- ${summary.counts.sources} reviewed sources across ${Object.keys(summary.counts.categories).length} source categories.
- ${summary.counts.priority_1_sources} priority-one sources with current or unusually concentrated owner intent.
- ${summary.counts.communities} community/forum sources.
- ${summary.counts.languages} languages or locale labels represented.
- ${summary.counts.official_archive_urls} deduplicated, public official-domain archive URLs from Common Crawl.
- ${summary.counts.official_archive_highlights} high-value support, firmware, dealer, documentation, technology, and owner-evidence archive URLs.
- ${summary.counts.youtube_videos} YouTube videos obtained through the official Data API.
- ${summary.counts.content_opportunities} model/problem content opportunities.
- ${summary.counts.outreach_actions} permission-aware outreach actions.

## First outreach targets

${markdownTable(topTargets, [
    { label: 'Rank', value: (row) => row.rank_score },
    { label: 'Source', value: (row) => `[${row.title}](${row.url})` },
    { label: 'Models', value: (row) => row.models.join(', ') },
    { label: 'Issues', value: (row) => row.issues.slice(0, 4).join(', ') },
    { label: 'Route', value: (row) => row.posting_route },
  ])}

## Most represented problem signals

${markdownTable(issueRows, [
    { label: 'Issue', value: (row) => row.issue },
    { label: 'Source count', value: (row) => row.count },
  ])}

## Official archive page types

${archiveTypeRows.length > 0 ? markdownTable(archiveTypeRows, [
    { label: 'Page type', value: (row) => row.pageType },
    { label: 'URL count', value: (row) => row.count },
  ]) : 'No network archive records in this run.'}

## Provider runs

### Common Crawl

${archiveRunRows.length > 0 ? markdownTable(archiveRunRows, [
    { label: 'Target', value: (row) => row.target_id },
    { label: 'OK', value: (row) => row.ok },
    { label: 'Accepted', value: (row) => row.accepted },
    { label: 'Rejected', value: (row) => row.rejected },
    { label: 'Error', value: (row) => row.error ?? '' },
  ]) : 'Not run. Use `npm run research:owners -- --network`.'}

### YouTube Data API

${youtubeRunRows.length > 0 ? markdownTable(youtubeRunRows, [
    { label: 'Query', value: (row) => row.query ?? 'provider' },
    { label: 'OK', value: (row) => row.ok },
    { label: 'Accepted', value: (row) => row.accepted ?? 0 },
    { label: 'Note', value: (row) => row.error ?? row.reason ?? '' },
  ]) : 'Not run.'}

## Guardrails

1. Participate publicly and transparently; do not auto-reply, mass-DM, or impersonate an owner.
2. Ask moderators before a standing support/resource post, especially on AVSForum and regional communities.
3. Use sanctioned APIs, RSS, archive indexes, native alerts, or written permission. Never bypass login walls, robots controls, CAPTCHA, rate limits, or anti-bot challenges.
4. Treat sold listings, app reviewers, campaign commenters, followers, and forum members as aggregate audience evidence—not a lead list.
5. Route interested owners into a first-party opt-in form with clear consent and deletion controls.
6. Do not redistribute manuals or firmware without provenance and rights review. Hash and malware-scan any recovery image before owner use.
`;
}

async function main() {
  const [rawSources, archiveTargets, searchQueries, contentOpportunities, outreachQueue, previousArchiveRecords, previousYouTubeRecords, previousSummary] = await Promise.all([
    readCsv('sources.csv'),
    readCsv('archive_targets.csv'),
    readCsv('search_queries.csv'),
    readCsv('content_opportunities.csv'),
    readCsv('outreach_queue.csv'),
    readOutputJsonLines('official_archive_urls.jsonl'),
    readOutputJsonLines('youtube_videos.jsonl'),
    readPreviousSummary(),
  ]);
  const sources = validateAndNormalizeSources(rawSources).sort(
    (a, b) => b.rank_score - a.rank_score || a.title.localeCompare(b.title),
  );
  const sourceIds = new Set(sources.map((source) => source.id));
  validateSourceReferences(contentOpportunities, 'source_ids', sourceIds, 'content_opportunities.csv');
  validateSourceReferences(outreachQueue, 'source_id', sourceIds, 'outreach_queue.csv');

  let commonCrawl = {
    records: previousArchiveRecords,
    runs: previousSummary?.providers?.common_crawl?.runs ?? [],
  };
  let youtube = {
    records: previousYouTubeRecords,
    runs: previousSummary?.providers?.youtube?.runs ?? [],
  };
  if (networkEnabled) {
    const [collectedCommonCrawl, collectedYouTube] = await Promise.all([
      collectCommonCrawl(archiveTargets),
      collectYouTubeVideoMetadata(process.env.OLIVE_YOUTUBE_API_KEY),
    ]);
    commonCrawl = {
      records: mergeLatestRecords(previousArchiveRecords, collectedCommonCrawl.records, 'url', 'capture_timestamp')
        .sort((a, b) => a.url.localeCompare(b.url)),
      runs: collectedCommonCrawl.runs,
    };
    youtube = {
      records: mergeLatestRecords(previousYouTubeRecords, collectedYouTube.records, 'video_id', 'published_at')
        .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at))),
      runs: collectedYouTube.runs,
    };
  }

  const categoryCounts = tally(sources, (source) => source.category);
  const languageCounts = tally(sources, (source) => source.language);
  const issueCounts = tally(sources, (source) => source.issues);
  const modelCounts = tally(sources, (source) => source.models);
  const archivePageTypeCounts = tally(commonCrawl.records, (record) => record.page_type);
  const archiveLocaleCounts = tally(commonCrawl.records, (record) => record.locale ?? 'unlabeled');
  const archiveHighlightTypes = new Set([
    'channel_partner',
    'documentation',
    'firmware_or_recovery',
    'owner_evidence',
    'support',
    'technology',
  ]);
  const archiveHighlights = commonCrawl.records.filter((record) => archiveHighlightTypes.has(record.page_type));
  const generatedAt = new Date().toISOString();
  const summary = {
    schema_version: 1,
    generated_at: generatedAt,
    mode: networkEnabled ? 'network' : 'offline',
    provider_data_mode: networkEnabled ? 'refreshed-and-merged' : 'preserved',
    privacy_scope: 'public page/thread metadata; no personal contact dataset',
    counts: {
      sources: sources.length,
      priority_1_sources: sources.filter((source) => source.priority === 1).length,
      communities: sources.filter((source) => source.category === 'community').length,
      languages: Object.keys(languageCounts).length,
      official_archive_urls: commonCrawl.records.length,
      official_archive_highlights: archiveHighlights.length,
      youtube_videos: youtube.records.length,
      search_queries: searchQueries.length,
      content_opportunities: contentOpportunities.length,
      outreach_actions: outreachQueue.length,
      categories: categoryCounts,
      languages_by_source: languageCounts,
      issues: issueCounts,
      models: modelCounts,
      archive_page_types: archivePageTypeCounts,
      archive_locales: archiveLocaleCounts,
    },
    providers: {
      common_crawl: { records: commonCrawl.records.length, runs: commonCrawl.runs },
      youtube: { records: youtube.records.length, runs: youtube.runs },
    },
  };

  await Promise.all([
    writeAtomic('sources.jsonl', asJsonLines(sources)),
    writeAtomic('official_archive_urls.jsonl', asJsonLines(commonCrawl.records)),
    writeAtomic('official_archive_highlights.jsonl', asJsonLines(archiveHighlights)),
    writeAtomic('youtube_videos.jsonl', asJsonLines(youtube.records)),
    writeAtomic('content_opportunities.jsonl', asJsonLines(contentOpportunities)),
    writeAtomic('outreach_queue.jsonl', asJsonLines(outreachQueue)),
    writeAtomic('summary.json', `${JSON.stringify(summary, null, 2)}\n`),
    writeAtomic('run-report.md', buildRunReport(summary, sources)),
  ]);

  process.stdout.write(
    `Compiled ${sources.length} sources, ${commonCrawl.records.length} archive URLs, ` +
      `${youtube.records.length} YouTube videos, ${searchQueries.length} search queries, ` +
      `${contentOpportunities.length} content opportunities, and ${outreachQueue.length} outreach actions.\n`,
  );
  process.stdout.write(`Report: ${path.relative(projectRoot, path.join(outputDirectory, 'run-report.md'))}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
