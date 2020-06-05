/**
 * @jest-environment node
 */

import { renderEditorString } from 'jest-remirror';
import javascript from 'refractor/lang/javascript';
import markdown from 'refractor/lang/markdown';
import typescript from 'refractor/lang/typescript';

import { ObjectNode } from '@remirror/core';

import { CodeBlockExtension } from '..';

const supportedLanguages = [typescript, javascript, markdown];
const create = (initialContent: ObjectNode) =>
  renderEditorString([new CodeBlockExtension({ supportedLanguages })], {
    props: { initialContent },
  });

test('ssr component', () => {
  const reactString = create({
    type: 'doc',
    content: [
      {
        type: 'codeBlock',
        content: [
          {
            type: 'text',
            text:
              'Simple Code Blocks\necho "fun times"\nUse Shift-Enter or Mod-Enter to hard break out of the code block',
          },
        ],
      },
    ],
  });

  expect(reactString).toInclude('<pre class="language-markup"><code>Simple Code Blocks');
  expect(reactString).toMatchSnapshot();
});

test('formatted ssr component', () => {
  const reactString = create({
    type: 'doc',
    content: [
      {
        type: 'codeBlock',
        attrs: { language: 'markdown' },
        content: [
          {
            type: 'text',
            text: '# Welcome\n**To the greatest show**\n\n_Ever created_.',
          },
        ],
      },
    ],
  });

  expect(reactString).toMatchSnapshot();
});
