// Every internal page URL, in one place. Components link with `href.<name>`, never with
// hand-written strings, so two things stay one-line changes:
// - porting a page: its entry moves from the old `.html` URL to the new folder URL;
// - the trailing-slash style (see src/routes/+layout.js), via `page()`.

/** A ported page's URL in the site's current style: folder URL with a trailing slash. */
export const page = (path) => (path === '/' ? '/' : `/${path.replace(/^\/|\/$/g, '')}/`);

export const href = {
  home: '/',
  hardware: '/what-hardware-to-buy.html',
  buildYourDisplay: '/build-your-display.html',
  impressum: page('impressum'),
  datenschutz: page('datenschutz'),

  protocol: page('protocol'),
  basicStandard: page('protocol/basic-standard'),
  bleFlow: page('protocol/ble-flow'),
  displayDataFormat: page('protocol/display-data-format'),
  flexStandard: page('protocol/flex-standard'),
  flexTools: page('protocol/flex-tools'),
  addingDisplays: page('protocol/adding-displays'),
  openDisplayLanguage: page('protocol/open-display-language'),
  firmwareVariants: page('protocol/reference-firmware-variants'),
  yamlConfig: page('protocol/yaml-config'),

  firmware: '/firmware/',
  reusingSolumDisplays: '/firmware/reusing_solum_displays.html',
  seeedCompatibility: '/firmware/seeed_display_compatibility.html',
  landing: '/l/',
  generateQr: '/l/generateqr.html',
  nrfWebTools: '/nrf_web_tools/',
  designer: '/designer/',
  toolbox: '/firmware/toolbox/',
  bleTester: '/firmware/display/',
  battery: '/firmware/battery/',
};

export const external = {
  github: 'https://github.com/OpenDisplay/',
  discord: 'https://discord.gg/XmTHz8RfJE',
  openHomeFoundation: 'https://www.openhomefoundation.org/',
};
