import React, { memo, useMemo } from 'react';
import MarkdownIt from 'markdown-it';

// Keep literal HTML as text; only Markdown syntax produces markup.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
const image = markdown.renderer.rules.image;
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('loading', 'lazy');
  tokens[index].attrSet('referrerpolicy', 'no-referrer');
  return image(tokens, index, options, env, renderer);
};

function NoteMarkdown({ text }) {
  const html = useMemo(() => markdown.render(text).trim(), [text]);
  return <div className="drive-note-body drive-note-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export default memo(NoteMarkdown);
