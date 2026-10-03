// Design-token rules (AGENTS.md): components use tokens from src/lib/ui/tokens.css only.
// Allowed raw values: 1px borders, 0, 50%, and fixed sizes (width/height) of icons and
// controls. Everything else that sets color, type size, spacing or radius uses a token.
// Positioning (top/left/inset) is geometry, e.g. a switch knob inside its track, not spacing.
const spacing = ['margin', 'padding', 'gap', 'row-gap', 'column-gap'];
const sides = ['-top', '-right', '-bottom', '-left', '-inline', '-block', '-inline-start', '-inline-end', '-block-start', '-block-end'];

export default {
  customSyntax: 'postcss-html',
  rules: {
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla'],
    'declaration-property-unit-disallowed-list': {
      'font-size': ['px', 'rem', 'em', 'pt'],
      'border-radius': ['px', 'rem', 'em'],
      ...Object.fromEntries(
        spacing.flatMap((p) => [p, ...(p.includes('gap') ? [] : sides.map((s) => p + s))])
          .map((p) => [p, ['px', 'rem', 'em']]),
      ),
    },
  },
  overrides: [
    { files: ['src/lib/ui/tokens.css'], rules: { 'color-no-hex': null, 'declaration-property-unit-disallowed-list': null } },
  ],
};
