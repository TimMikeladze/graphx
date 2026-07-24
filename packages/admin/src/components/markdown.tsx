import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

/**
 * Rendered markdown for node bodies. Raw HTML in the source is NOT rendered — `rehype-raw` is
 * deliberately absent, so ingested third-party content can't inject markup into the admin UI.
 * Visual styling lives in the `.markdown` component class (`index.css`), against the design tokens.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("markdown", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => {
            void node // react-markdown's hast node — dropped so it never reaches the DOM
            return <a {...props} target="_blank" rel="noreferrer noopener" />
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
