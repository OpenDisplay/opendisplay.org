<script>
  import Card from '#lib/ui/Card.svelte';
  import Page from '#lib/ui/Page.svelte';
  import Prose from '#lib/ui/Prose.svelte';
  import { href } from '#lib/paths.js';
</script>

<svelte:head>
  <title>OpenDisplay Language Specification · OpenDisplay</title>
</svelte:head>

<Page title="OpenDisplay Language Specification" width="prose">
  {#snippet lead()}Part of the <strong><a href={href.basicStandard}>OpenDisplay spec</a></strong>{/snippet}

  <Card>
    <Prose>
      <h2>Overview</h2>
      <p>
        OpenDisplay Language (ODL) is a standardized format for describing visual layouts for e-paper
        displays. Senders use it to describe what to draw; receivers render the result using the shared
        <a href={href.displayDataFormat}>display data format</a>. It is independent of whether the device uses
        a fixed product profile or reference firmware with
        <a href={href.flexStandard}>Flex</a> configuration.
      </p>
      <p>
        The payload is a list of drawing elements that define what to display. Each element must specify its
        type and required properties. The elements are drawn in order from first to last. ODL is used by the
        <a href="https://github.com/OpenDisplay/Home_Assistant_Integration">Home Assistant integration</a> and
        can be authored with the <a href={href.designer}>Layout Designer</a>.
      </p>
    </Prose>
  </Card>

  <h3>Table of Contents</h3>
  <ul>
    <li><a href="#basic-usage">Basic Usage</a></li>
    <li><a href="#color-support">Color Support</a></li>
    <li><a href="#font-support">Font Support</a></li>
    <li>
      <a href="#draw-types">Draw Types</a>
      <ul>
        <li><a href="#debug_grid">Debug Grid</a></li>
        <li><a href="#text">Text</a></li>
        <li><a href="#multiline">Multiline Text</a></li>
        <li><a href="#line">Line</a></li>
        <li><a href="#rectangle">Rectangle</a></li>
        <li><a href="#rectangle_pattern">Rectangle Pattern</a></li>
        <li><a href="#polygon">Polygon</a></li>
        <li><a href="#circle">Circle</a></li>
        <li><a href="#ellipse">Ellipse</a></li>
        <li><a href="#arc">Arc/Pie Slice</a></li>
        <li><a href="#icon">Icon</a></li>
        <li><a href="#icon_sequence">Icon Sequence</a></li>
        <li><a href="#dlimg">Download Image</a></li>
        <li><a href="#qrcode">QR Code</a></li>
        <li><a href="#plot">Plot</a></li>
        <li><a href="#progress_bar">Progress Bar</a></li>
      </ul>
    </li>
    <li><a href="#template-examples">Template Examples</a></li>
  </ul>

  <Card>
    <Prose>
      <h2 id="basic-usage">Basic Usage</h2>
      <p>
        E-paper displays come in multiple variants - red and yellow are the most common accent colors. The
        following options are available when using OpenDisplay Language:
      </p>

      <h3>Example Payload</h3>
      <pre><code
          >- type: text
  value: Hello World!
  font: ppb.ttf
  x: 0
  y: 0
  size: 40
  color: red
- type: icon
  value: account-cowboy-hat
  x: 60
  y: 120
  size: 120
  color: red</code
        ></pre>

      <h3>Service Options</h3>
      <p>
        When using OpenDisplay Language with services (such as Home Assistant's drawcustom service), these
        options are available:
      </p>
      <table>
        <thead>
          <tr>
            <th>Option</th>
            <th>Description</th>
            <th>Default</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>payload</code></td>
            <td>List of drawing elements (YAML)</td>
            <td>-</td>
          </tr>
          <tr>
            <td><code>background</code></td>
            <td>Background color</td>
            <td>white</td>
          </tr>
          <tr>
            <td><code>rotate</code></td>
            <td>Rotation of image</td>
            <td>0</td>
          </tr>
          <tr>
            <td><code>dither</code></td>
            <td>Dithering (see table below)</td>
            <td>2</td>
          </tr>
          <tr>
            <td><code>ttl</code></td>
            <td>Cache time in seconds</td>
            <td>60</td>
          </tr>
          <tr>
            <td><code>dry-run</code></td>
            <td>Generate without sending</td>
            <td>false</td>
          </tr>
        </tbody>
      </table>

      <h3>Dithering Options</h3>
      <table>
        <thead>
          <tr>
            <th>Dither</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>0</code></td>
            <td>No dithering</td>
          </tr>
          <tr>
            <td><code>1</code></td>
            <td>Floyd-Steinberg dithering (best for photos)</td>
          </tr>
          <tr>
            <td><code>2</code></td>
            <td>Ordered dithering (default, best for halftone colors)</td>
          </tr>
        </tbody>
      </table>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="color-support">Color Support</h2>
      <p>
        E-paper displays predominantly come in two variants: red and yellow accent colors (displays with more
        colors also exist). You can specify colors in several ways:
      </p>
      <ul>
        <li>
          Using explicit colors: <code>"black"</code>, <code>"white"</code>, <code>"red"</code>,
          <code>"yellow"</code>
        </li>
        <li>
          Using halftone colors (set <code>dither=2</code>): <code>"half_black"</code> (or
          <code>"gray"</code>, <code>"grey"</code>, <code>"half_white"</code>), <code>"half_red"</code>,
          <code>"half_yellow"</code>
        </li>
        <li>
          Using single letter shortcuts: <code>"b"</code> (black), <code>"w"</code> (white), <code>"r"</code>
          (red), <code>"y"</code> (yellow)
        </li>
        <li>
          Using halftone shortcuts: <code>"hb"</code>, <code>"hw"</code> (50% black/gray), <code>"hr"</code>
          (50% red), <code>"hy"</code> (50% yellow)
        </li>
        <li>
          Using <code>"accent"</code>, <code>"a"</code>, <code>"half_accent"</code>, or <code>"ha"</code> to automatically
          use the display's accent color (red or yellow depending on the hardware)
        </li>
        <li>
          Using hex colors: <code>"#RGB"</code> or <code>"#RRGGBB"</code> (e.g., <code>"#F00"</code> or
          <code>"#FF0000"</code> for red)
        </li>
      </ul>

      <h3>Example Payload Adapting to Display Color</h3>
      <pre><code
          >- type: text
  value: Hello World!
  font: ppb.ttf
  x: 0
  y: 0
  size: 40
  color: accent  # Will be red or yellow depending on the display</code
        ></pre>

      <h3>Color Support by Element Type</h3>
      <p>
        All elements that support colors (text, shapes, icons, etc.) accept the following color properties:
      </p>
      <table>
        <thead>
          <tr>
            <th>Property</th>
            <th>Description</th>
            <th>Values</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>color</code></td>
            <td>Primary color</td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code>, <code>#RRGGBB</code></td
            >
          </tr>
          <tr>
            <td><code>fill</code></td>
            <td>Fill color</td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code>, <code>#RRGGBB</code></td
            >
          </tr>
          <tr>
            <td><code>outline</code></td>
            <td>Outline/border color</td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code>, <code>#RRGGBB</code></td
            >
          </tr>
          <tr>
            <td><code>background</code></td>
            <td>Background color (when applicable)</td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code>, <code>#RRGGBB</code></td
            >
          </tr>
        </tbody>
      </table>
      <p>
        Using <code>"accent"</code> is recommended for portable scripts that should work with both red and yellow
        displays.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="font-support">Font Support</h2>
      <p>Custom fonts are supported for text elements. Fonts can be specified in several ways:</p>

      <h3>Specifying Fonts</h3>
      <pre><code
          ># Using the default font (ppb.ttf)
- type: text
  value: Default font
  font: ppb.ttf # Optional, you can also omit this line
  x: 10
  y: 10

# Using just the filename (searched in all font directories)
- type: text
  value: "Custom Font"
  font: "CustomFont.ttf"
  x: 10
  y: 50

# Using the absolute path (direct access)
- type: text
  value: "Custom Font with Path"
  font: "/media/GothamBold-Rnd.ttf"
  x: 10
  y: 90</code
        ></pre>

      <h3>Default Fonts</h3>
      <p>The following default fonts are always available:</p>
      <ul>
        <li><code>ppb.ttf</code></li>
        <li><code>rbm.ttf</code></li>
      </ul>
      <p>These are always available and will be used as fallbacks if specified fonts cannot be found.</p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="draw-types">Draw Types</h2>
      <p>The following drawing element types are supported in OpenDisplay Language:</p>

      <h3 id="debug_grid">debug_grid</h3>
      <p>
        The <code>debug_grid</code> draw type overlays a grid on the image canvas to help with layout debugging.
      </p>
      <pre><code>- type: debug_grid</code></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>spacing</code></td>
            <td>Distance between grid lines</td>
            <td>No</td>
            <td><code>20</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>line_color</code></td>
            <td>Color of the grid lines</td>
            <td>No</td>
            <td><code>black</code></td>
            <td>Any supported color</td>
          </tr>
          <tr>
            <td><code>dashed</code></td>
            <td>Whether to use dashed lines for the grid</td>
            <td>No</td>
            <td><code>True</code></td>
            <td><code>True</code>, <code>False</code></td>
          </tr>
          <tr>
            <td><code>dash_length</code></td>
            <td>Length of dash segments (if dashed)</td>
            <td>No</td>
            <td><code>2</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>space_length</code></td>
            <td>Space between the dashes (if dashed)</td>
            <td>No</td>
            <td><code>4</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>show_labels</code></td>
            <td>Whether to label coordinates at grid lines</td>
            <td>No</td>
            <td><code>True</code></td>
            <td><code>True</code>, <code>False</code></td>
          </tr>
          <tr>
            <td><code>label_step</code></td>
            <td>Frequency of labels (every Nth) grid line</td>
            <td>No</td>
            <td><code>40</code> (2*<code>spacing</code>)</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>label_color</code></td>
            <td>Color of the coordinate labels</td>
            <td>No</td>
            <td><code>black</code></td>
            <td>Any supported color</td>
          </tr>
          <tr>
            <td><code>label_font_size</code></td>
            <td>Font size for coordinate labels</td>
            <td>No</td>
            <td><code>12</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>font</code></td>
            <td>Font for labels</td>
            <td>No</td>
            <td><code>ppb.ttf</code></td>
            <td>-</td>
          </tr>
        </tbody>
      </table>

      <h3 id="text">text</h3>
      <p>Draws text.</p>
      <pre><code
          >- type: text
  value: "Hello World!"
  font: "/media/custom.ttf"
  x: 0
  y: 0
  size: 40
  color: red</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>value</code></td>
            <td>Text to display</td>
            <td>Yes</td>
            <td>-</td>
            <td>String</td>
          </tr>
          <tr>
            <td><code>x</code></td>
            <td>X position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y</code></td>
            <td>Y position</td>
            <td>No</td>
            <td>Last text position + y_padding</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>size</code></td>
            <td>Font size</td>
            <td>No</td>
            <td><code>20</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>font</code></td>
            <td>Font file name</td>
            <td>No</td>
            <td><code>ppb.ttf</code></td>
            <td>Available fonts: <code>ppb.ttf</code>, <code>rbm.ttf</code>, or custom</td>
          </tr>
          <tr>
            <td><code>color</code></td>
            <td>Text color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td><code>black</code>, <code>white</code>, <code>red</code>, <code>yellow</code></td>
          </tr>
          <tr>
            <td><code>anchor</code></td>
            <td>Text anchor point</td>
            <td>No</td>
            <td><code>lt</code> (left-top)</td>
            <td>Pillow text anchors</td>
          </tr>
          <tr>
            <td><code>max_width</code></td>
            <td>Maximum text width before wrapping</td>
            <td>No</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>spacing</code></td>
            <td>Line spacing for wrapped text</td>
            <td>No</td>
            <td><code>5</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>stroke_width</code></td>
            <td>Outline width</td>
            <td>No</td>
            <td><code>0</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>stroke_fill</code></td>
            <td>Outline color</td>
            <td>No</td>
            <td><code>white</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>y_padding</code></td>
            <td>Vertical offset when y not specified</td>
            <td>No</td>
            <td><code>10</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
          <tr>
            <td><code>parse_colors</code></td>
            <td>Enable color markup in text</td>
            <td>No</td>
            <td><code>false</code></td>
            <td>Enables <code>[color]text[/color]</code> syntax</td>
          </tr>
          <tr>
            <td><code>truncate</code></td>
            <td>Truncate text if exceeds max_width</td>
            <td>No</td>
            <td><code>false</code></td>
            <td>Adds ellipsis (...) when truncating</td>
          </tr>
        </tbody>
      </table>

      <h4>Inline Color Markup</h4>
      <p>
        Text elements support inline color markup when <code>parse_colors</code> is enabled. This allows different
        parts of the text to be rendered in different colors without needing to create multiple text elements.
      </p>
      <p>Color markup syntax:</p>
      <pre><code>[color]text[/color]</code></pre>
      <p>Available colors:</p>
      <ul>
        <li><code>black</code> - Black text</li>
        <li><code>white</code> - White text</li>
        <li><code>red</code> - Red text (for red displays)</li>
        <li><code>yellow</code> - Yellow text (for yellow displays)</li>
        <li><code>accent</code> - Uses the display's accent color (red or yellow depending on hardware)</li>
      </ul>
      <pre><code
          ># Simple colored text
- type: text
  value: "Temperature: [red]25°C[/red]"
  x: 10
  y: 10
  parse_colors: true

# Multiple colors
- type: text
  value: "[black]Current[/black] temp: [accent]25°C[/accent]"
  x: 10
  y: 40
  parse_colors: true</code
        ></pre>

      <h3 id="multiline">multiline</h3>
      <p>Splits text into multiple lines based on a delimiter.</p>
      <pre><code
          >- type: multiline
  value: "Line 1|Line 2|Line 3"
  delimiter: "|"
  font: "ppb.ttf"
  x: 0
  offset_y: 50
  size: 40
  color: black</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>value</code></td>
            <td>Text with delimiters</td>
            <td>Yes</td>
            <td>-</td>
            <td>String</td>
          </tr>
          <tr>
            <td><code>delimiter</code></td>
            <td>Character to split text</td>
            <td>Yes</td>
            <td>-</td>
            <td>Single character</td>
          </tr>
          <tr>
            <td><code>x</code></td>
            <td>X position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>offset_y</code></td>
            <td>Vertical spacing between lines</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>y</code></td>
            <td>Starting Y position</td>
            <td>No</td>
            <td>Last position + y_padding</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>size</code></td>
            <td>Font size</td>
            <td>No</td>
            <td><code>20</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>font</code></td>
            <td>Font file name</td>
            <td>No</td>
            <td><code>ppb.ttf</code></td>
            <td>Available fonts: <code>ppb.ttf</code>, <code>rbm.ttf</code></td>
          </tr>
          <tr>
            <td><code>color</code></td>
            <td>Text color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>spacing</code></td>
            <td>Additional line spacing</td>
            <td>No</td>
            <td><code>0</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
        </tbody>
      </table>

      <h3 id="line">line</h3>
      <p>Draws a straight line.</p>
      <pre><code
          >- type: line
  x_start: 20
  x_end: 380
  y_start: 15
  y_end: 15
  width: 1
  fill: red</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>x_start</code></td>
            <td>Starting X position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>x_end</code></td>
            <td>Ending X position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y_start</code></td>
            <td>Starting Y position</td>
            <td>No</td>
            <td>Auto-positioned</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y_end</code></td>
            <td>Ending Y position</td>
            <td>No</td>
            <td><code>y_start</code></td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>fill</code></td>
            <td>Line color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>width</code></td>
            <td>Line thickness</td>
            <td>No</td>
            <td><code>1</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>y_padding</code></td>
            <td>Vertical offset when auto-positioned</td>
            <td>No</td>
            <td><code>0</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>dashed</code></td>
            <td>Enable dashed line behaviour</td>
            <td>No</td>
            <td><code>False</code></td>
            <td><code>False</code>, <code>True</code></td>
          </tr>
          <tr>
            <td><code>dash_length</code></td>
            <td>Length of dashes</td>
            <td>No</td>
            <td><code>5</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>space_length</code></td>
            <td>Length of spaces between dashes</td>
            <td>No</td>
            <td><code>3</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>True</code></td>
            <td><code>True</code>, <code>False</code></td>
          </tr>
        </tbody>
      </table>

      <h3 id="rectangle">rectangle</h3>
      <p>Draws a rectangle with optional rounded corners.</p>
      <pre><code
          >- type: rectangle
  x_start: 20
  x_end: 80
  y_start: 15
  y_end: 30
  width: 2
  fill: red
  outline: black</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>x_start</code></td>
            <td>Left position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>x_end</code></td>
            <td>Right position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y_start</code></td>
            <td>Top position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y_end</code></td>
            <td>Bottom position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>fill</code></td>
            <td>Fill color</td>
            <td>No</td>
            <td><code>null</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code>, <code>null</code></td
            >
          </tr>
          <tr>
            <td><code>outline</code></td>
            <td>Border color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>width</code></td>
            <td>Border thickness</td>
            <td>No</td>
            <td><code>1</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>radius</code></td>
            <td>Corner radius</td>
            <td>No</td>
            <td><code>0</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>corners</code></td>
            <td>Which corners to round</td>
            <td>No</td>
            <td><code>all</code></td>
            <td
              ><code>all</code> or comma-separated list of: <code>top_left</code>, <code>top_right</code>,
              <code>bottom_left</code>, <code>bottom_right</code></td
            >
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
        </tbody>
      </table>

      <h3 id="rectangle_pattern">rectangle_pattern</h3>
      <p>Draws repeated rectangles in a grid pattern.</p>
      <pre><code
          >- type: rectangle_pattern
  x_start: 5
  x_size: 35
  x_offset: 10
  y_start: 28
  y_size: 18
  y_offset: 2
  fill: white
  outline: red
  width: 1
  x_repeat: 1
  y_repeat: 4</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>x_start</code></td>
            <td>Starting X position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>x_size</code></td>
            <td>Width of each rectangle</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>x_offset</code></td>
            <td>Horizontal spacing</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>y_start</code></td>
            <td>Starting Y position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y_size</code></td>
            <td>Height of each rectangle</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>y_offset</code></td>
            <td>Vertical spacing</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>x_repeat</code></td>
            <td>Number of horizontal repeats</td>
            <td>Yes</td>
            <td>-</td>
            <td>Integer</td>
          </tr>
          <tr>
            <td><code>y_repeat</code></td>
            <td>Number of vertical repeats</td>
            <td>Yes</td>
            <td>-</td>
            <td>Integer</td>
          </tr>
          <tr>
            <td><code>fill</code></td>
            <td>Fill color</td>
            <td>No</td>
            <td><code>null</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code>, <code>null</code></td
            >
          </tr>
          <tr>
            <td><code>outline</code></td>
            <td>Border color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>width</code></td>
            <td>Border thickness</td>
            <td>No</td>
            <td><code>1</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
        </tbody>
      </table>

      <h3 id="polygon">polygon</h3>
      <p>Draws a filled or outlined polygon based on the provided points.</p>
      <pre><code
          >- type: polygon
  points: [[10, 10], [50, 10], [50, 50], [10, 50]]
  fill: "red"
  outline: "black"</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>points</code></td>
            <td>List of coordinate pairs for the polygon</td>
            <td>Yes</td>
            <td>-</td>
            <td>Example: <code>[[x1, y1], ...]</code></td>
          </tr>
          <tr>
            <td><code>fill</code></td>
            <td>Fill color for the polygon</td>
            <td>No</td>
            <td><code>none</code></td>
            <td>Any supported color</td>
          </tr>
          <tr>
            <td><code>outline</code></td>
            <td>Outline color for the polygon</td>
            <td>No</td>
            <td><code>black</code></td>
            <td>Any supported color</td>
          </tr>
          <tr>
            <td><code>width</code></td>
            <td>Width of the outline</td>
            <td>No</td>
            <td><code>1</code></td>
            <td>Pixels</td>
          </tr>
        </tbody>
      </table>

      <h3 id="circle">circle</h3>
      <p>Draws a circle around a center point.</p>
      <pre><code
          >- type: circle
  x: 50
  y: 50
  radius: 20</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>x</code></td>
            <td>Center X position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y</code></td>
            <td>Center Y position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>radius</code></td>
            <td>Circle radius</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>fill</code></td>
            <td>Fill color</td>
            <td>No</td>
            <td><code>null</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code>, <code>null</code></td
            >
          </tr>
          <tr>
            <td><code>outline</code></td>
            <td>Border color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>width</code></td>
            <td>Border thickness</td>
            <td>No</td>
            <td><code>1</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
        </tbody>
      </table>

      <h3 id="ellipse">ellipse</h3>
      <p>Draws an ellipse inside the bounding box.</p>
      <pre><code
          >- type: ellipse
  x_start: 50
  x_end: 100
  y_start: 50
  y_end: 100</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>x_start</code></td>
            <td>Left position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>x_end</code></td>
            <td>Right position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y_start</code></td>
            <td>Top position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y_end</code></td>
            <td>Bottom position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>fill</code></td>
            <td>Fill color</td>
            <td>No</td>
            <td><code>null</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code>, <code>null</code></td
            >
          </tr>
          <tr>
            <td><code>outline</code></td>
            <td>Border color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>width</code></td>
            <td>Border thickness</td>
            <td>No</td>
            <td><code>1</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
        </tbody>
      </table>

      <h3 id="arc">arc</h3>
      <p>
        Draws an arc (outline-only) or a pie slice (filled) based on the specified center, radius, and angles.
      </p>
      <pre><code
          >- type: arc
  x: 100
  y: 75
  radius: 50
  start_angle: 0
  end_angle: 90
  fill: red</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>x</code></td>
            <td>X coordinate of the center</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y</code></td>
            <td>Y coordinate of the center</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>radius</code></td>
            <td>Radius of the arc or pie slice</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>start_angle</code></td>
            <td>Starting angle of the arc</td>
            <td>Yes</td>
            <td>-</td>
            <td>0 degrees = right</td>
          </tr>
          <tr>
            <td><code>end_angle</code></td>
            <td>Ending angle of the arc</td>
            <td>Yes</td>
            <td>-</td>
            <td>Clockwise direction</td>
          </tr>
          <tr>
            <td><code>fill</code></td>
            <td>Fill color for the pie slice</td>
            <td>No</td>
            <td><code>none</code></td>
            <td>Use to make a pie slice</td>
          </tr>
          <tr>
            <td><code>outline</code></td>
            <td>Outline color for arcs or pie slices</td>
            <td>No</td>
            <td><code>black</code></td>
            <td>-</td>
          </tr>
          <tr>
            <td><code>width</code></td>
            <td>Width of the outline</td>
            <td>No</td>
            <td><code>1</code></td>
            <td>Ignored if fill is provided</td>
          </tr>
        </tbody>
      </table>

      <h3 id="icon">icon</h3>
      <p>Draws Material Design Icons.</p>
      <pre><code
          >- type: icon
  value: "account-cowboy-hat"
  x: 60
  y: 120
  size: 120
  color: red</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>value</code></td>
            <td>Icon name</td>
            <td>Yes</td>
            <td>-</td>
            <td
              >From <a href="https://pictogrammers.com/library/mdi/" target="_blank" rel="noopener"
                >Material Design Icons</a
              ></td
            >
          </tr>
          <tr>
            <td><code>x</code></td>
            <td>X position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y</code></td>
            <td>Y position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>size</code></td>
            <td>Icon size</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>fill</code></td>
            <td>Icon color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>anchor</code></td>
            <td>Icon anchor point</td>
            <td>No</td>
            <td><code>la</code></td>
            <td>See text anchors</td>
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
        </tbody>
      </table>
      <p>
        Note: Icon name can be prefixed with <code>mdi:</code> (e.g., <code>mdi:account-cowboy-hat</code>)
      </p>

      <h3 id="icon_sequence">icon_sequence</h3>
      <p>Draws multiple Material Design Icons in a sequence with specified direction and spacing.</p>
      <pre><code
          >- type: icon_sequence
  x: 10
  y: 10
  icons:
    - mdi:home
    - mdi:arrow-right
    - mdi:office-building
  size: 24
  direction: right</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>x</code></td>
            <td>X position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y</code></td>
            <td>Y position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>icons</code></td>
            <td>List of icon names</td>
            <td>Yes</td>
            <td>-</td>
            <td
              >From <a href="https://pictogrammers.com/library/mdi/" target="_blank" rel="noopener"
                >Material Design Icons</a
              ></td
            >
          </tr>
          <tr>
            <td><code>size</code></td>
            <td>Size of each icon</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>direction</code></td>
            <td>Direction of sequence</td>
            <td>No</td>
            <td><code>right</code></td>
            <td><code>right</code>, <code>left</code>, <code>up</code>, <code>down</code></td>
          </tr>
          <tr>
            <td><code>spacing</code></td>
            <td>Space between icons</td>
            <td>No</td>
            <td>size/4</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>fill</code></td>
            <td>Icon color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>anchor</code></td>
            <td>Icon anchor point</td>
            <td>No</td>
            <td><code>la</code></td>
            <td>See text anchors</td>
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
        </tbody>
      </table>

      <h3 id="dlimg">dlimg</h3>
      <p>Downloads and displays an image from a URL.</p>
      <pre><code
          >- type: dlimg
  url: "https://upload.wikimedia.org/wikipedia/en/9/9a/Trollface_non-free.png"
  x: 10
  y: 10
  xsize: 120
  ysize: 120
  rotate: 0</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>url</code></td>
            <td>Image URL or path</td>
            <td>Yes</td>
            <td>-</td>
            <td>HTTP/HTTPS URL, Data URI, local path or camera/image entity</td>
          </tr>
          <tr>
            <td><code>x</code></td>
            <td>X position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>y</code></td>
            <td>Y position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>xsize</code></td>
            <td>Target width</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>ysize</code></td>
            <td>Target height</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>resize_method</code></td>
            <td>Resizing method</td>
            <td>No</td>
            <td><code>stretch</code></td>
            <td><code>stretch</code>, <code>crop</code>, <code>cover</code>, <code>contain</code></td>
          </tr>
          <tr>
            <td><code>rotate</code></td>
            <td>Rotation angle</td>
            <td>No</td>
            <td><code>0</code></td>
            <td>Degrees</td>
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
        </tbody>
      </table>
      <p>Notes:</p>
      <ul>
        <li>Local images must be in <code>/config/media/</code></li>
        <li>Data URIs supported (e.g., <code>data:image/gif;base64,...</code>)</li>
        <li>External images must be publicly accessible</li>
        <li>
          Camera entities (e.g. <code>camera.p1s_camera</code>) must have a <code>entity_picture</code> attribute
        </li>
      </ul>

      <h3 id="qrcode">qrcode</h3>
      <p>Generates and displays a QR code.</p>
      <pre><code
          >- type: qrcode
  data: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  x: 140
  y: 50
  boxsize: 2
  border: 2
  color: "black"
  bgcolor: "white"</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>data</code></td>
            <td>Content to encode</td>
            <td>Yes</td>
            <td>-</td>
            <td>String</td>
          </tr>
          <tr>
            <td><code>x</code></td>
            <td>X position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y</code></td>
            <td>Y position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>boxsize</code></td>
            <td>Size of each QR box</td>
            <td>No</td>
            <td><code>2</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>border</code></td>
            <td>QR code border width</td>
            <td>No</td>
            <td><code>1</code></td>
            <td>Units</td>
          </tr>
          <tr>
            <td><code>color</code></td>
            <td>QR code color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>bgcolor</code></td>
            <td>Background color</td>
            <td>No</td>
            <td><code>white</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
        </tbody>
      </table>

      <h3 id="plot">plot</h3>
      <p>Renders historical data from Home Assistant entities as a line plot.</p>
      <pre><code
          >- type: plot
  x_start: 10
  y_start: 20
  x_end: 199
  y_end: 119
  duration: 36000 # 10 hours in seconds
  low: 10
  high: 20
  font: "ppb.ttf"
  data:
    - entity: sensor.temperature
      width: 3
    - entity: sensor.humidity
      color: red</code
        ></pre>
      <p>
        The plot element supports extensive configuration for axes, legends, and data series. For complete
        documentation of all plot options including Y-Legend, Y-Axis, X-Legend, X-Axis, and line options,
        please refer to the <a href="https://github.com/OpenDisplay/Home_Assistant_Integration"
          >Home Assistant Integration documentation</a
        >
        or use the <a href={href.designer}>Layout Designer</a> to explore all available options.
      </p>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>data</code></td>
            <td>List of entities to plot</td>
            <td>Yes</td>
            <td>-</td>
            <td>Array</td>
          </tr>
          <tr>
            <td><code>ylegend</code></td>
            <td>Y-axis legend options</td>
            <td>No</td>
            <td>-</td>
            <td>See Y-Legend Options</td>
          </tr>
          <tr>
            <td><code>yaxis</code></td>
            <td>Y-axis options</td>
            <td>No</td>
            <td>-</td>
            <td>See Y-Axis Options</td>
          </tr>
          <tr>
            <td><code>xlegend</code></td>
            <td>X-axis legend options</td>
            <td>No</td>
            <td>-</td>
            <td>See X-Legend Options</td>
          </tr>
          <tr>
            <td><code>xaxis</code></td>
            <td>X-axis options</td>
            <td>No</td>
            <td>-</td>
            <td>See X-Axis Options</td>
          </tr>
          <tr>
            <td><code>x_start</code></td>
            <td>Left position</td>
            <td>No</td>
            <td><code>0</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>y_start</code></td>
            <td>Top position</td>
            <td>No</td>
            <td><code>0</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>x_end</code></td>
            <td>Right position</td>
            <td>No</td>
            <td>Canvas width</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>y_end</code></td>
            <td>Bottom position</td>
            <td>No</td>
            <td>Canvas height</td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>duration</code></td>
            <td>Time range</td>
            <td>No</td>
            <td><code>86400</code></td>
            <td>Seconds</td>
          </tr>
          <tr>
            <td><code>low</code></td>
            <td>Minimum Y value</td>
            <td>No</td>
            <td>Auto</td>
            <td>Number</td>
          </tr>
          <tr>
            <td><code>high</code></td>
            <td>Maximum Y value</td>
            <td>No</td>
            <td>Auto</td>
            <td>Number</td>
          </tr>
          <tr>
            <td><code>font</code></td>
            <td>Font for Legend Text</td>
            <td>No</td>
            <td><code>ppb.ttf</code></td>
            <td>Font name</td>
          </tr>
          <tr>
            <td><code>round_values</code></td>
            <td>Round min/max to integers</td>
            <td>No</td>
            <td><code>false</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
          <tr>
            <td><code>size</code></td>
            <td>Font size</td>
            <td>No</td>
            <td><code>10</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>debug</code></td>
            <td>Show debug borders</td>
            <td>No</td>
            <td><code>false</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
        </tbody>
      </table>
      <h4>Line Options (per entity)</h4>
      <p>Each entry in the <code>data</code> array can have these options:</p>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>entity</code></td>
            <td>Entity ID to plot</td>
            <td>Yes</td>
            <td>-</td>
            <td>String</td>
          </tr>
          <tr>
            <td><code>color</code></td>
            <td>Line color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td>Any supported color</td>
          </tr>
          <tr>
            <td><code>width</code></td>
            <td>Line width</td>
            <td>No</td>
            <td><code>1</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>span_gaps</code></td>
            <td>Connect lines across gaps</td>
            <td>No</td>
            <td><code>false</code></td>
            <td><code>true</code>, <code>false</code>, or seconds</td>
          </tr>
          <tr>
            <td><code>smooth</code></td>
            <td>Curve smoothing</td>
            <td>No</td>
            <td><code>false</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
          <tr>
            <td><code>line_style</code></td>
            <td>Line style</td>
            <td>No</td>
            <td><code>linear</code></td>
            <td><code>linear</code> or <code>step</code></td>
          </tr>
          <tr>
            <td><code>show_points</code></td>
            <td>Show data points</td>
            <td>No</td>
            <td><code>false</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
          <tr>
            <td><code>point_size</code></td>
            <td>Data point size</td>
            <td>No</td>
            <td><code>3</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>point_color</code></td>
            <td>Data point color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td>Any supported color</td>
          </tr>
          <tr>
            <td><code>value_scale</code></td>
            <td>Scale data points by a factor</td>
            <td>No</td>
            <td><code>1.0</code></td>
            <td>Float</td>
          </tr>
        </tbody>
      </table>

      <h3 id="progress_bar">progress_bar</h3>
      <p>Displays a progress bar with optional percentage text.</p>
      <pre><code
          >- type: progress_bar
  x_start: 10
  y_start: 10
  x_end: 280
  y_end: 30
  fill: red
  outline: black
  width: 1
  progress: 42
  direction: right
  show_percentage: true
  font: "ppb.ttf"</code
        ></pre>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Description</th>
            <th>Required</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>x_start</code></td>
            <td>Left position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y_start</code></td>
            <td>Top position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>x_end</code></td>
            <td>Right position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>y_end</code></td>
            <td>Bottom position</td>
            <td>Yes</td>
            <td>-</td>
            <td>Pixels or percentage</td>
          </tr>
          <tr>
            <td><code>progress</code></td>
            <td>Progress value</td>
            <td>Yes</td>
            <td>-</td>
            <td>0-100 (clamped)</td>
          </tr>
          <tr>
            <td><code>direction</code></td>
            <td>Fill direction</td>
            <td>No</td>
            <td><code>right</code></td>
            <td><code>right</code>, <code>left</code>, <code>up</code>, <code>down</code></td>
          </tr>
          <tr>
            <td><code>background</code></td>
            <td>Background color</td>
            <td>No</td>
            <td><code>white</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>fill</code></td>
            <td>Progress bar color</td>
            <td>No</td>
            <td><code>red</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>outline</code></td>
            <td>Border color</td>
            <td>No</td>
            <td><code>black</code></td>
            <td
              ><code>white</code>, <code>black</code>, <code>accent</code>, <code>red</code>,
              <code>yellow</code></td
            >
          </tr>
          <tr>
            <td><code>width</code></td>
            <td>Border thickness</td>
            <td>No</td>
            <td><code>1</code></td>
            <td>Pixels</td>
          </tr>
          <tr>
            <td><code>show_percentage</code></td>
            <td>Show percentage text</td>
            <td>No</td>
            <td><code>false</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
          <tr>
            <td><code>font</code></td>
            <td>Percentage text font</td>
            <td>No</td>
            <td><code>ppb.ttf</code></td>
            <td>Font name</td>
          </tr>
          <tr>
            <td><code>visible</code></td>
            <td>Show/hide element</td>
            <td>No</td>
            <td><code>true</code></td>
            <td><code>true</code>, <code>false</code></td>
          </tr>
        </tbody>
      </table>
    </Prose>
  </Card>
  <Card>
    <Prose>
      <h2 id="template-examples">Template Examples</h2>
      <p>
        OpenDisplay Language supports template expressions (when used with Home Assistant) for dynamic
        content:
      </p>

      <h3>Basic State Display</h3>
      <pre><code
          >- type: "text"
  value: "Temperature: &#123;&#123; states('sensor.temperature') &#125;&#125;°C"
  x: 10
  y: 10</code
        ></pre>

      <h3>Conditional Formatting</h3>
      <pre><code
          >- type: "text"
  value: >
    Status:
    [&#123;&#123; 'red' if is_state('binary_sensor.door', 'on') else 'black' &#125;&#125;]
    &#123;&#123; states('binary_sensor.door') &#125;&#125;
    [/&#123;&#123; 'red' if is_state('binary_sensor.door', 'on') else 'black' &#125;&#125;]
  parse_colors: true
  x: 10
  y: 10</code
        ></pre>

      <h3>Dynamic Positioning</h3>
      <pre><code
          >- type: "text"
  value: "Centered"
  x: "50%"
  y: "50%"
  anchor: "mm"</code
        ></pre>

      <h3>Common Use Cases</h3>
      <h4>Battery Status with Icon</h4>
      <pre><code
          >- type: "icon"
  value: "mdi:battery"
  x: 10
  y: 10
  size: 24
  color: "&#123;&#123; 'red' if states('sensor.battery')|float &lt; 20 else 'black' &#125;&#125;"
- type: "text"
  value: "&#123;&#123; states('sensor.battery') &#125;&#125;%"
  x: 40
  y: 10</code
        ></pre>

      <h4>Header with Divider</h4>
      <pre><code
          >- type: "text"
  value: "Status Overview"
  x: 10
  y: 10
  size: 24
- type: "line"
  x_start: 10
  x_end: 286
  y_start: 40
  width: 2</code
        ></pre>

      <h4>Multi-Sensor Display</h4>
      <pre><code
          >- type: "text"
  value: "Living Room"
  x: 10
  y: 10
  size: 24
- type: "icon"
  value: "mdi:thermometer"
  x: 10
  y: 40
  size: 20
- type: "text"
  value: "&#123;&#123; states('sensor.living_room_temperature') &#125;&#125;°C"
  x: 35
  y: 40
- type: "icon"
  value: "mdi:water-percent"
  x: 10
  y: 70
  size: 20
- type: "text"
  value: "&#123;&#123; states('sensor.living_room_humidity') &#125;&#125;%"
  x: 35
  y: 70</code
        ></pre>
    </Prose>
  </Card>
</Page>
