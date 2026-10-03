import { ColorScheme, getPalette } from '@opendisplay/epaper-dithering';
import { describe, expect, it } from 'vitest';
import { SCHEMES } from '../../src/lib/ui/inks.js';

const hex = ({ r, g, b }) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('swatch inks', () => {
  const schemes = Object.entries(ColorScheme).filter(([, value]) => typeof value === 'number');

  it('covers every color scheme the dithering library knows', () => {
    expect(Object.keys(SCHEMES).map(Number).sort((a, b) => a - b)).toEqual(schemes.map(([, v]) => v).sort((a, b) => a - b));
  });

  it.each(schemes)('%s matches the library palette, in order', (name, value) => {
    const library = Object.entries(getPalette(value).colors).map(([ink, color]) => [ink, hex(color)]);
    expect(SCHEMES[value].name).toBe(name);
    expect(SCHEMES[value].inks).toEqual(library);
  });
});
