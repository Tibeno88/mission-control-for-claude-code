import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// No rehype-raw: LLM output is untrusted, raw HTML stays escaped.
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer" />
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
