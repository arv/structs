// markdown-it-container ships no types

declare module 'markdown-it-container' {
  import type {MarkdownIt, Token} from 'markdown-it';

  type Options = {
    marker?: string;
    validate?: (params: string, markup: string) => boolean;
    render?: (tokens: Token[], index: number) => string;
  };

  const container: (md: MarkdownIt, name: string, options?: Options) => void;
  export default container;
}

// nor does Eleventy, for what the site and its tests use of it

declare module '@11ty/eleventy' {
  export type Page = {
    url: string | false;
    inputPath: string;
    outputPath: string | false;
    content: string;
  };

  export default class Eleventy {
    constructor(
      input?: string,
      output?: string,
      options?: {configPath?: string; quietMode?: boolean},
    );
    toJSON(): Promise<Page[]>;
  }

  export const EleventyHtmlBasePlugin: unknown;
}
