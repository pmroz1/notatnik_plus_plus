import { parseSnippet } from './snippet';

describe('parseSnippet', () => {
  it('splits marked matches into parts without interpreting HTML', () => {
    expect(parseSnippet('a \u0002b\u0003 <img src=x>')).toEqual([
      { text: 'a ', match: false },
      { text: 'b', match: true },
      { text: ' <img src=x>', match: false },
    ]);
  });
});
