import { defineParams } from '@sveltejs/kit/params';
import { REDIRECTS } from '#lib/redirects.js';

export const params = defineParams({
  // Only old URLs listed in the redirect map reach the redirect route.
  legacy: (param) => (Object.hasOwn(REDIRECTS, `/${param}`) ? param : undefined),
});
