// The inks of each firmware color scheme, in palette order, as shown by <Swatch>.
// These are the ideal colors from @opendisplay/epaper-dithering's palettes; a unit test
// (tests/ui/inks.test.js) keeps this table identical to the library. They are data about
// displays, not theme colors, so they live here rather than in tokens.css.

export const SCHEMES = {
  0: { name: 'MONO', label: 'Black and white', inks: [['black', '#000000'], ['white', '#ffffff']] },
  1: { name: 'BWR', label: 'Black, white, red', inks: [['black', '#000000'], ['white', '#ffffff'], ['red', '#ff0000']] },
  2: { name: 'BWY', label: 'Black, white, yellow', inks: [['black', '#000000'], ['white', '#ffffff'], ['yellow', '#ffff00']] },
  3: { name: 'BWRY', label: 'Black, white, red, yellow', inks: [['black', '#000000'], ['white', '#ffffff'], ['yellow', '#ffff00'], ['red', '#ff0000']] },
  4: { name: 'BWGBRY', label: 'Spectra 6', inks: [['black', '#000000'], ['white', '#ffffff'], ['yellow', '#ffff00'], ['red', '#ff0000'], ['blue', '#0000ff'], ['green', '#00ff00']] },
  5: { name: 'GRAYSCALE_4', label: '4 grays', inks: [['black', '#000000'], ['gray1', '#555555'], ['gray2', '#aaaaaa'], ['white', '#ffffff']] },
  6: { name: 'GRAYSCALE_16', label: '16 grays', inks: [['black', '#000000'], ['gray1', '#111111'], ['gray2', '#222222'], ['gray3', '#333333'], ['gray4', '#444444'], ['gray5', '#555555'], ['gray6', '#666666'], ['gray7', '#777777'], ['gray8', '#888888'], ['gray9', '#999999'], ['gray10', '#aaaaaa'], ['gray11', '#bbbbbb'], ['gray12', '#cccccc'], ['gray13', '#dddddd'], ['gray14', '#eeeeee'], ['white', '#ffffff']] },
  7: { name: 'SEVEN_COLOR', label: '7-color', inks: [['black', '#000000'], ['white', '#ffffff'], ['yellow', '#ffff00'], ['red', '#ff0000'], ['blue', '#0000ff'], ['green', '#00ff00'], ['orange', '#ff8000']] },
  8: { name: 'BWGBRY_SPLIT', label: 'Spectra 6 (split)', inks: [['black', '#000000'], ['white', '#ffffff'], ['yellow', '#ffff00'], ['red', '#ff0000'], ['blue', '#0000ff'], ['green', '#00ff00']] },
  9: { name: 'GRAYSCALE_8', label: '8 grays', inks: [['black', '#000000'], ['gray1', '#242424'], ['gray2', '#494949'], ['gray3', '#6d6d6d'], ['gray4', '#929292'], ['gray5', '#b6b6b6'], ['gray6', '#dbdbdb'], ['white', '#ffffff']] },
};
