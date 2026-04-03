/**
 * publisher.js — PublisherAgent
 *
 * Subscribes to:  seo.done
 * Publishes to:   published
 *
 * Final step: assembles the complete content package and renders it
 * in the requested output format (markdown | html | json).
 * In production, replace the write-to-disk step with a CMS API call.
 */

import { BaseAgent }   from '../core/base.js';
import { createBus }   from '../core/bus.js';
import { createStore } from '../core/store.js';
import { config }      from '../core/config.js';
import fs              from 'fs/promises';
import path            from 'path';

export class PublisherAgent extends BaseAgent {
  inputTopic  = 'seo.done';
  outputTopic = 'published';

  async process(content) {
    const { draft, seo, topic, outputFormat = 'markdown' } = content;

    await fs.mkdir(config.OUTPUT_DIR, { recursive: true });

    let rendered, filename;
    if (outputFormat === 'html') {
      rendered = renderHTML(draft, seo);
      filename = `${seo.slug}.html`;
    } else if (outputFormat === 'json') {
      rendered = JSON.stringify({ draft, seo }, null, 2);
      filename = `${seo.slug}.json`;
    } else {
      rendered = renderMarkdown(draft, seo);
      filename = `${seo.slug}.md`;
    }

    const outputPath = path.join(config.OUTPUT_DIR, filename);
    await fs.writeFile(outputPath, rendered, 'utf8');

    console.log(`[PublisherAgent] 📄  Saved: ${outputPath}`);
    console.log(`[PublisherAgent] 📊  Word count: ${draft.wordCount}`);
    console.log(`[PublisherAgent] 🔑  Primary keyword: "${seo.primaryKeyword}"`);

    return {
      publishedAt:    new Date().toISOString(),
      outputPath,
      outputFormat,
      finalWordCount: draft.wordCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderMarkdown(draft, seo) {
  const lines = [
    `---`,
    `title: "${seo.metaTitle}"`,
    `description: "${seo.metaDescription}"`,
    `slug: ${seo.slug}`,
    `keywords: [${[seo.primaryKeyword, ...seo.secondaryKeywords].map(k => `"${k}"`).join(', ')}]`,
    `---`,
    ``,
    `# ${draft.title}`,
    ``,
    draft.hook,
    ``,
  ];
  for (const s of draft.sections) {
    lines.push(`## ${s.heading}`, ``, s.content, ``);
  }
  lines.push(`---`, ``, draft.callToAction);
  return lines.join('\n');
}

function renderHTML(draft, seo) {
  const sectionsHTML = draft.sections
    .map(s => `  <section>\n    <h2>${s.heading}</h2>\n    <p>${s.content.replace(/\n/g, '</p><p>')}</p>\n  </section>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${seo.metaTitle}</title>
  <meta name="description" content="${seo.metaDescription}"/>
  <meta name="keywords" content="${[seo.primaryKeyword, ...seo.secondaryKeywords].join(', ')}"/>
</head>
<body>
  <article>
    <h1>${draft.title}</h1>
    <p class="hook">${draft.hook}</p>
${sectionsHTML}
    <footer><p>${draft.callToAction}</p></footer>
  </article>
</body>
</html>`;
}

if (process.argv[1]?.endsWith('publisher.js')) {
  const bus   = await createBus();
  const store = createStore(bus.mode === 'redis');
  const agent = new PublisherAgent({ bus, store, name: 'PublisherAgent' });
  await agent.start();
}
