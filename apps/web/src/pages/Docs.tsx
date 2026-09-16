import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Menu } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// In-app documentation. Every `NN-slug.md` file in src/docs/ becomes a page:
// the NN prefix orders the sidebar, the slug is the URL (/docs/<slug>), and the
// first `# heading` is the title. Adding/removing/reordering docs is purely a
// matter of managing files in that folder — no registry to maintain.
const files = import.meta.glob('../docs/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface DocPage {
  slug: string;
  title: string;
  order: number;
  content: string;
}

const PAGES: DocPage[] = Object.entries(files)
  .map(([file, content]) => {
    const base = file.split('/').pop()!.replace(/\.md$/i, '');
    const m = /^(\d+)-(.+)$/.exec(base);
    const order = m?.[1] ? Number(m[1]) : 999;
    const slug = (m?.[2] ?? base).toLowerCase();
    const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
    const title = heading ?? slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
    return { slug, title, order, content };
  })
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

export function Docs() {
  const { slug } = useParams<{ slug: string }>();
  const page = PAGES.find((p) => p.slug === slug) ?? PAGES[0];
  // Mobile only (CSS hides the button on desktop): the sidebar becomes a
  // fly-out toggled by the hamburger; picking a page or tapping the backdrop
  // closes it.
  const [navOpen, setNavOpen] = useState(false);

  if (!page) {
    return (
      <section>
        <h1>Docs</h1>
        <p className="muted">
          No documentation pages found — add markdown files to <code>apps/web/src/docs/</code>.
        </p>
      </section>
    );
  }

  return (
    <section>
      <div className="docs-layout">
        <button
          type="button"
          className="docs-menu-btn"
          onClick={() => setNavOpen((v) => !v)}
          aria-expanded={navOpen}
          aria-label="Toggle documentation menu"
        >
          <Menu size={16} aria-hidden /> {page.title}
        </button>
        {navOpen && <div className="docs-backdrop" onClick={() => setNavOpen(false)} aria-hidden />}
        <nav
          className={`docs-nav${navOpen ? ' docs-nav-open' : ''}`}
          aria-label="Documentation pages"
        >
          {PAGES.map((p) => (
            <Link
              key={p.slug}
              to={`/docs/${p.slug}`}
              className={p.slug === page.slug ? 'docs-active' : undefined}
              onClick={() => setNavOpen(false)}
            >
              {p.title}
            </Link>
          ))}
        </nav>
        <article className="doc-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // In-app links (/docs/…, /scenarios, …) go through the router so
              // they don't trigger a full page reload; external ones open in a
              // new tab.
              a: ({ href, children }) =>
                href?.startsWith('/') ? (
                  <Link to={href}>{children}</Link>
                ) : (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
            }}
          >
            {page.content}
          </ReactMarkdown>
        </article>
      </div>
    </section>
  );
}
