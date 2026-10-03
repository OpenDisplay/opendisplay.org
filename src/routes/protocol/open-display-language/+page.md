---
title: "OpenDisplay Language Specification"
lead: "Part of the <strong><a href=\"/protocol/basic-standard.html\">OpenDisplay spec</a></strong>"
---

## Overview

OpenDisplay Language (ODL) is a standardized format for describing visual layouts for e-paper displays. Senders use it to describe what to draw; receivers render the result using the shared [display data format](/protocol/display-data-format/). It is independent of whether the device uses a fixed product profile or reference firmware with [Flex](/protocol/flex-standard/) configuration.

The payload is a list of drawing elements that define what to display. Each element must specify its type and required properties. The elements are drawn in order from first to last. ODL is used by the [Home Assistant integration](https://github.com/OpenDisplay/Home_Assistant_Integration) and can be authored with the [Layout Designer](/designer/).

## Basic Usage

E-paper displays come in multiple variants - red and yellow are the most common accent colors. The following options are available when using OpenDisplay Language:

### Example Payload

```
- type: text
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
  color: red
```

### Service Options

When using OpenDisplay Language with services (such as Home Assistant's drawcustom service), these options are available:

| Option | Description | Default |
| --- | --- | --- |
| `payload` | List of drawing elements (YAML) | \- |
| `background` | Background color | white |
| `rotate` | Rotation of image | 0 |
| `dither` | Dithering (see table below) | 2 |
| `ttl` | Cache time in seconds | 60 |
| `dry-run` | Generate without sending | false |

### Dithering Options

| Dither | Description |
| --- | --- |
| `0` | No dithering |
| `1` | Floyd-Steinberg dithering (best for photos) |
| `2` | Ordered dithering (default, best for halftone colors) |

## Color Support

E-paper displays predominantly come in two variants: red and yellow accent colors (displays with more colors also exist). You can specify colors in several ways:

-   Using explicit colors: `"black"`, `"white"`, `"red"`, `"yellow"`
-   Using halftone colors (set `dither=2`): `"half_black"` (or `"gray"`, `"grey"`, `"half_white"`), `"half_red"`, `"half_yellow"`
-   Using single letter shortcuts: `"b"` (black), `"w"` (white), `"r"` (red), `"y"` (yellow)
-   Using halftone shortcuts: `"hb"`, `"hw"` (50% black/gray), `"hr"` (50% red), `"hy"` (50% yellow)
-   Using `"accent"`, `"a"`, `"half_accent"`, or `"ha"` to automatically use the display's accent color (red or yellow depending on the hardware)
-   Using hex colors: `"#RGB"` or `"#RRGGBB"` (e.g., `"#F00"` or `"#FF0000"` for red)

### Example Payload Adapting to Display Color

```
- type: text
  value: Hello World!
  font: ppb.ttf
  x: 0
  y: 0
  size: 40
  color: accent  # Will be red or yellow depending on the display
```

### Color Support by Element Type

All elements that support colors (text, shapes, icons, etc.) accept the following color properties:

| Property | Description | Values |
| --- | --- | --- |
| `color` | Primary color | `white`, `black`, `accent`, `red`, `yellow`, `#RRGGBB` |
| `fill` | Fill color | `white`, `black`, `accent`, `red`, `yellow`, `#RRGGBB` |
| `outline` | Outline/border color | `white`, `black`, `accent`, `red`, `yellow`, `#RRGGBB` |
| `background` | Background color (when applicable) | `white`, `black`, `accent`, `red`, `yellow`, `#RRGGBB` |

Using `"accent"` is recommended for portable scripts that should work with both red and yellow displays.

## Font Support

Custom fonts are supported for text elements. Fonts can be specified in several ways:

### Specifying Fonts

```
# Using the default font (ppb.ttf)
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
  y: 90
```

### Default Fonts

The following default fonts are always available:

-   `ppb.ttf`
-   `rbm.ttf`

These are always available and will be used as fallbacks if specified fonts cannot be found.

## Draw Types

The following drawing element types are supported in OpenDisplay Language:

<h3 id="debug_grid">debug_grid</h3>

The `debug_grid` draw type overlays a grid on the image canvas to help with layout debugging.

```
- type: debug_grid
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `spacing` | Distance between grid lines | No | `20` | Pixels |
| `line_color` | Color of the grid lines | No | `black` | Any supported color |
| `dashed` | Whether to use dashed lines for the grid | No | `True` | `True`, `False` |
| `dash_length` | Length of dash segments (if dashed) | No | `2` | Pixels |
| `space_length` | Space between the dashes (if dashed) | No | `4` | Pixels |
| `show_labels` | Whether to label coordinates at grid lines | No | `True` | `True`, `False` |
| `label_step` | Frequency of labels (every Nth) grid line | No | `40` (2\*`spacing`) | Pixels |
| `label_color` | Color of the coordinate labels | No | `black` | Any supported color |
| `label_font_size` | Font size for coordinate labels | No | `12` | Pixels |
| `font` | Font for labels | No | `ppb.ttf` | \- |

### text

Draws text.

```
- type: text
  value: "Hello World!"
  font: "/media/custom.ttf"
  x: 0
  y: 0
  size: 40
  color: red
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `value` | Text to display | Yes | \- | String |
| `x` | X position | Yes | \- | Pixels or percentage |
| `y` | Y position | No | Last text position + y\_padding | Pixels or percentage |
| `size` | Font size | No | `20` | Pixels |
| `font` | Font file name | No | `ppb.ttf` | Available fonts: `ppb.ttf`, `rbm.ttf`, or custom |
| `color` | Text color | No | `black` | `black`, `white`, `red`, `yellow` |
| `anchor` | Text anchor point | No | `lt` (left-top) | Pillow text anchors |
| `max_width` | Maximum text width before wrapping | No | \- | Pixels or percentage |
| `spacing` | Line spacing for wrapped text | No | `5` | Pixels |
| `stroke_width` | Outline width | No | `0` | Pixels |
| `stroke_fill` | Outline color | No | `white` | `white`, `black`, `accent`, `red`, `yellow` |
| `y_padding` | Vertical offset when y not specified | No | `10` | Pixels |
| `visible` | Show/hide element | No | `true` | `true`, `false` |
| `parse_colors` | Enable color markup in text | No | `false` | Enables `[color]text[/color]` syntax |
| `truncate` | Truncate text if exceeds max\_width | No | `false` | Adds ellipsis (...) when truncating |

#### Inline Color Markup

Text elements support inline color markup when `parse_colors` is enabled. This allows different parts of the text to be rendered in different colors without needing to create multiple text elements.

Color markup syntax:

```
[color]text[/color]
```

Available colors:

-   `black` - Black text
-   `white` - White text
-   `red` - Red text (for red displays)
-   `yellow` - Yellow text (for yellow displays)
-   `accent` - Uses the display's accent color (red or yellow depending on hardware)

```
# Simple colored text
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
  parse_colors: true
```

### multiline

Splits text into multiple lines based on a delimiter.

```
- type: multiline
  value: "Line 1|Line 2|Line 3"
  delimiter: "|"
  font: "ppb.ttf"
  x: 0
  offset_y: 50
  size: 40
  color: black
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `value` | Text with delimiters | Yes | \- | String |
| `delimiter` | Character to split text | Yes | \- | Single character |
| `x` | X position | Yes | \- | Pixels or percentage |
| `offset_y` | Vertical spacing between lines | Yes | \- | Pixels |
| `y` | Starting Y position | No | Last position + y\_padding | Pixels or percentage |
| `size` | Font size | No | `20` | Pixels |
| `font` | Font file name | No | `ppb.ttf` | Available fonts: `ppb.ttf`, `rbm.ttf` |
| `color` | Text color | No | `black` | `white`, `black`, `accent`, `red`, `yellow` |
| `spacing` | Additional line spacing | No | `0` | Pixels |
| `visible` | Show/hide element | No | `true` | `true`, `false` |

### line

Draws a straight line.

```
- type: line
  x_start: 20
  x_end: 380
  y_start: 15
  y_end: 15
  width: 1
  fill: red
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `x_start` | Starting X position | Yes | \- | Pixels or percentage |
| `x_end` | Ending X position | Yes | \- | Pixels or percentage |
| `y_start` | Starting Y position | No | Auto-positioned | Pixels or percentage |
| `y_end` | Ending Y position | No | `y_start` | Pixels or percentage |
| `fill` | Line color | No | `black` | `white`, `black`, `accent`, `red`, `yellow` |
| `width` | Line thickness | No | `1` | Pixels |
| `y_padding` | Vertical offset when auto-positioned | No | `0` | Pixels |
| `dashed` | Enable dashed line behaviour | No | `False` | `False`, `True` |
| `dash_length` | Length of dashes | No | `5` | Pixels |
| `space_length` | Length of spaces between dashes | No | `3` | Pixels |
| `visible` | Show/hide element | No | `True` | `True`, `False` |

### rectangle

Draws a rectangle with optional rounded corners.

```
- type: rectangle
  x_start: 20
  x_end: 80
  y_start: 15
  y_end: 30
  width: 2
  fill: red
  outline: black
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `x_start` | Left position | Yes | \- | Pixels or percentage |
| `x_end` | Right position | Yes | \- | Pixels or percentage |
| `y_start` | Top position | Yes | \- | Pixels or percentage |
| `y_end` | Bottom position | Yes | \- | Pixels or percentage |
| `fill` | Fill color | No | `null` | `white`, `black`, `accent`, `red`, `yellow`, `null` |
| `outline` | Border color | No | `black` | `white`, `black`, `accent`, `red`, `yellow` |
| `width` | Border thickness | No | `1` | Pixels |
| `radius` | Corner radius | No | `0` | Pixels |
| `corners` | Which corners to round | No | `all` | `all` or comma-separated list of: `top_left`, `top_right`, `bottom_left`, `bottom_right` |
| `visible` | Show/hide element | No | `true` | `true`, `false` |

<h3 id="rectangle_pattern">rectangle_pattern</h3>

Draws repeated rectangles in a grid pattern.

```
- type: rectangle_pattern
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
  y_repeat: 4
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `x_start` | Starting X position | Yes | \- | Pixels or percentage |
| `x_size` | Width of each rectangle | Yes | \- | Pixels |
| `x_offset` | Horizontal spacing | Yes | \- | Pixels |
| `y_start` | Starting Y position | Yes | \- | Pixels or percentage |
| `y_size` | Height of each rectangle | Yes | \- | Pixels |
| `y_offset` | Vertical spacing | Yes | \- | Pixels |
| `x_repeat` | Number of horizontal repeats | Yes | \- | Integer |
| `y_repeat` | Number of vertical repeats | Yes | \- | Integer |
| `fill` | Fill color | No | `null` | `white`, `black`, `accent`, `red`, `yellow`, `null` |
| `outline` | Border color | No | `black` | `white`, `black`, `accent`, `red`, `yellow` |
| `width` | Border thickness | No | `1` | Pixels |
| `visible` | Show/hide element | No | `true` | `true`, `false` |

### polygon

Draws a filled or outlined polygon based on the provided points.

```
- type: polygon
  points: [[10, 10], [50, 10], [50, 50], [10, 50]]
  fill: "red"
  outline: "black"
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `points` | List of coordinate pairs for the polygon | Yes | \- | Example: `[[x1, y1], ...]` |
| `fill` | Fill color for the polygon | No | `none` | Any supported color |
| `outline` | Outline color for the polygon | No | `black` | Any supported color |
| `width` | Width of the outline | No | `1` | Pixels |

### circle

Draws a circle around a center point.

```
- type: circle
  x: 50
  y: 50
  radius: 20
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `x` | Center X position | Yes | \- | Pixels or percentage |
| `y` | Center Y position | Yes | \- | Pixels or percentage |
| `radius` | Circle radius | Yes | \- | Pixels |
| `fill` | Fill color | No | `null` | `white`, `black`, `accent`, `red`, `yellow`, `null` |
| `outline` | Border color | No | `black` | `white`, `black`, `accent`, `red`, `yellow` |
| `width` | Border thickness | No | `1` | Pixels |
| `visible` | Show/hide element | No | `true` | `true`, `false` |

### ellipse

Draws an ellipse inside the bounding box.

```
- type: ellipse
  x_start: 50
  x_end: 100
  y_start: 50
  y_end: 100
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `x_start` | Left position | Yes | \- | Pixels or percentage |
| `x_end` | Right position | Yes | \- | Pixels or percentage |
| `y_start` | Top position | Yes | \- | Pixels or percentage |
| `y_end` | Bottom position | Yes | \- | Pixels or percentage |
| `fill` | Fill color | No | `null` | `white`, `black`, `accent`, `red`, `yellow`, `null` |
| `outline` | Border color | No | `black` | `white`, `black`, `accent`, `red`, `yellow` |
| `width` | Border thickness | No | `1` | Pixels |
| `visible` | Show/hide element | No | `true` | `true`, `false` |

### arc

Draws an arc (outline-only) or a pie slice (filled) based on the specified center, radius, and angles.

```
- type: arc
  x: 100
  y: 75
  radius: 50
  start_angle: 0
  end_angle: 90
  fill: red
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `x` | X coordinate of the center | Yes | \- | Pixels or percentage |
| `y` | Y coordinate of the center | Yes | \- | Pixels or percentage |
| `radius` | Radius of the arc or pie slice | Yes | \- | Pixels |
| `start_angle` | Starting angle of the arc | Yes | \- | 0 degrees = right |
| `end_angle` | Ending angle of the arc | Yes | \- | Clockwise direction |
| `fill` | Fill color for the pie slice | No | `none` | Use to make a pie slice |
| `outline` | Outline color for arcs or pie slices | No | `black` | \- |
| `width` | Width of the outline | No | `1` | Ignored if fill is provided |

### icon

Draws Material Design Icons.

```
- type: icon
  value: "account-cowboy-hat"
  x: 60
  y: 120
  size: 120
  color: red
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `value` | Icon name | Yes | \- | From [Material Design Icons](https://pictogrammers.com/library/mdi/) |
| `x` | X position | Yes | \- | Pixels or percentage |
| `y` | Y position | Yes | \- | Pixels or percentage |
| `size` | Icon size | Yes | \- | Pixels |
| `fill` | Icon color | No | `black` | `white`, `black`, `accent`, `red`, `yellow` |
| `anchor` | Icon anchor point | No | `la` | See text anchors |
| `visible` | Show/hide element | No | `true` | `true`, `false` |

Note: Icon name can be prefixed with `mdi:` (e.g., `mdi:account-cowboy-hat`)

<h3 id="icon_sequence">icon_sequence</h3>

Draws multiple Material Design Icons in a sequence with specified direction and spacing.

```
- type: icon_sequence
  x: 10
  y: 10
  icons:
    - mdi:home
    - mdi:arrow-right
    - mdi:office-building
  size: 24
  direction: right
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `x` | X position | Yes | \- | Pixels or percentage |
| `y` | Y position | Yes | \- | Pixels or percentage |
| `icons` | List of icon names | Yes | \- | From [Material Design Icons](https://pictogrammers.com/library/mdi/) |
| `size` | Size of each icon | Yes | \- | Pixels |
| `direction` | Direction of sequence | No | `right` | `right`, `left`, `up`, `down` |
| `spacing` | Space between icons | No | size/4 | Pixels |
| `fill` | Icon color | No | `black` | `white`, `black`, `accent`, `red`, `yellow` |
| `anchor` | Icon anchor point | No | `la` | See text anchors |
| `visible` | Show/hide element | No | `true` | `true`, `false` |

### dlimg

Downloads and displays an image from a URL.

```
- type: dlimg
  url: "https://upload.wikimedia.org/wikipedia/en/9/9a/Trollface_non-free.png"
  x: 10
  y: 10
  xsize: 120
  ysize: 120
  rotate: 0
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `url` | Image URL or path | Yes | \- | HTTP/HTTPS URL, Data URI, local path or camera/image entity |
| `x` | X position | Yes | \- | Pixels |
| `y` | Y position | Yes | \- | Pixels |
| `xsize` | Target width | Yes | \- | Pixels |
| `ysize` | Target height | Yes | \- | Pixels |
| `resize_method` | Resizing method | No | `stretch` | `stretch`, `crop`, `cover`, `contain` |
| `rotate` | Rotation angle | No | `0` | Degrees |
| `visible` | Show/hide element | No | `true` | `true`, `false` |

Notes:

-   Local images must be in `/config/media/`
-   Data URIs supported (e.g., `data:image/gif;base64,...`)
-   External images must be publicly accessible
-   Camera entities (e.g. `camera.p1s_camera`) must have a `entity_picture` attribute

### qrcode

Generates and displays a QR code.

```
- type: qrcode
  data: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  x: 140
  y: 50
  boxsize: 2
  border: 2
  color: "black"
  bgcolor: "white"
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `data` | Content to encode | Yes | \- | String |
| `x` | X position | Yes | \- | Pixels or percentage |
| `y` | Y position | Yes | \- | Pixels or percentage |
| `boxsize` | Size of each QR box | No | `2` | Pixels |
| `border` | QR code border width | No | `1` | Units |
| `color` | QR code color | No | `black` | `white`, `black`, `accent`, `red`, `yellow` |
| `bgcolor` | Background color | No | `white` | `white`, `black`, `accent`, `red`, `yellow` |
| `visible` | Show/hide element | No | `true` | `true`, `false` |

### plot

Renders historical data from Home Assistant entities as a line plot.

```
- type: plot
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
      color: red
```

The plot element supports extensive configuration for axes, legends, and data series. For complete documentation of all plot options including Y-Legend, Y-Axis, X-Legend, X-Axis, and line options, please refer to the [Home Assistant Integration documentation](https://github.com/OpenDisplay/Home_Assistant_Integration) or use the [Layout Designer](/designer/) to explore all available options.

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `data` | List of entities to plot | Yes | \- | Array |
| `ylegend` | Y-axis legend options | No | \- | See Y-Legend Options |
| `yaxis` | Y-axis options | No | \- | See Y-Axis Options |
| `xlegend` | X-axis legend options | No | \- | See X-Legend Options |
| `xaxis` | X-axis options | No | \- | See X-Axis Options |
| `x_start` | Left position | No | `0` | Pixels |
| `y_start` | Top position | No | `0` | Pixels |
| `x_end` | Right position | No | Canvas width | Pixels |
| `y_end` | Bottom position | No | Canvas height | Pixels |
| `duration` | Time range | No | `86400` | Seconds |
| `low` | Minimum Y value | No | Auto | Number |
| `high` | Maximum Y value | No | Auto | Number |
| `font` | Font for Legend Text | No | `ppb.ttf` | Font name |
| `round_values` | Round min/max to integers | No | `false` | `true`, `false` |
| `size` | Font size | No | `10` | Pixels |
| `debug` | Show debug borders | No | `false` | `true`, `false` |
| `visible` | Show/hide element | No | `true` | `true`, `false` |

#### Line Options (per entity)

Each entry in the `data` array can have these options:

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `entity` | Entity ID to plot | Yes | \- | String |
| `color` | Line color | No | `black` | Any supported color |
| `width` | Line width | No | `1` | Pixels |
| `span_gaps` | Connect lines across gaps | No | `false` | `true`, `false`, or seconds |
| `smooth` | Curve smoothing | No | `false` | `true`, `false` |
| `line_style` | Line style | No | `linear` | `linear` or `step` |
| `show_points` | Show data points | No | `false` | `true`, `false` |
| `point_size` | Data point size | No | `3` | Pixels |
| `point_color` | Data point color | No | `black` | Any supported color |
| `value_scale` | Scale data points by a factor | No | `1.0` | Float |

<h3 id="progress_bar">progress_bar</h3>

Displays a progress bar with optional percentage text.

```
- type: progress_bar
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
  font: "ppb.ttf"
```

| Parameter | Description | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `x_start` | Left position | Yes | \- | Pixels or percentage |
| `y_start` | Top position | Yes | \- | Pixels or percentage |
| `x_end` | Right position | Yes | \- | Pixels or percentage |
| `y_end` | Bottom position | Yes | \- | Pixels or percentage |
| `progress` | Progress value | Yes | \- | 0-100 (clamped) |
| `direction` | Fill direction | No | `right` | `right`, `left`, `up`, `down` |
| `background` | Background color | No | `white` | `white`, `black`, `accent`, `red`, `yellow` |
| `fill` | Progress bar color | No | `red` | `white`, `black`, `accent`, `red`, `yellow` |
| `outline` | Border color | No | `black` | `white`, `black`, `accent`, `red`, `yellow` |
| `width` | Border thickness | No | `1` | Pixels |
| `show_percentage` | Show percentage text | No | `false` | `true`, `false` |
| `font` | Percentage text font | No | `ppb.ttf` | Font name |
| `visible` | Show/hide element | No | `true` | `true`, `false` |

## Template Examples

OpenDisplay Language supports template expressions (when used with Home Assistant) for dynamic content:

### Basic State Display

```
- type: "text"
  value: "Temperature: {{ states('sensor.temperature') }}°C"
  x: 10
  y: 10
```

### Conditional Formatting

```
- type: "text"
  value: >
    Status:
    [{{ 'red' if is_state('binary_sensor.door', 'on') else 'black' }}]
    {{ states('binary_sensor.door') }}
    [/{{ 'red' if is_state('binary_sensor.door', 'on') else 'black' }}]
  parse_colors: true
  x: 10
  y: 10
```

### Dynamic Positioning

```
- type: "text"
  value: "Centered"
  x: "50%"
  y: "50%"
  anchor: "mm"
```

### Common Use Cases

#### Battery Status with Icon

```
- type: "icon"
  value: "mdi:battery"
  x: 10
  y: 10
  size: 24
  color: "{{ 'red' if states('sensor.battery')|float < 20 else 'black' }}"
- type: "text"
  value: "{{ states('sensor.battery') }}%"
  x: 40
  y: 10
```

#### Header with Divider

```
- type: "text"
  value: "Status Overview"
  x: 10
  y: 10
  size: 24
- type: "line"
  x_start: 10
  x_end: 286
  y_start: 40
  width: 2
```

#### Multi-Sensor Display

```
- type: "text"
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
  value: "{{ states('sensor.living_room_temperature') }}°C"
  x: 35
  y: 40
- type: "icon"
  value: "mdi:water-percent"
  x: 10
  y: 70
  size: 20
- type: "text"
  value: "{{ states('sensor.living_room_humidity') }}%"
  x: 35
  y: 70
```
