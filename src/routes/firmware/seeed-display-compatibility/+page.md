---
title: "Seeed Display Compatibility"
---

<script>
  import Badge from '#lib/ui/Badge.svelte';
</script>

## Seeed Studio ePaper Display Support

Overview of known and expected compatibility for **Seeed Studio ePaper displays** when used with **OpenDisplay Firmware**, based on current community testing and hardware constraints.

| Product Name | Resolution | Display Color | Connector | Partial Refresh | OpenDisplay Support |
| --- | --- | --- | --- | --- | --- |
| [1.54" Monochrome ePaper Display](https://www.seeedstudio.com/1-54-Monochrome-ePaper-Display-with-200x200-Pixels-p-5776.html) | 200 × 200<br><small>184 PPI</small> | Monochrome | <Badge>24 pin</Badge> | <Badge tone="ok">Yes</Badge> | <Badge tone="ok">Yes</Badge><br><small>ID: 26</small> |
| [2.13" Monochrome ePaper Display](https://www.seeedstudio.com/2-13-Monochrome-ePaper-Display-with-122x250-Pixels-p-5778.html) | 250 × 122<br><small>131 PPI</small> | Monochrome | <Badge>24 pin</Badge> | <Badge tone="ok">Yes</Badge> | <Badge tone="ok">Yes</Badge><br><small>Setup as 128 × 250 ID: 3</small> |
| [2.13" Quadruple Color ePaper Display](https://www.seeedstudio.com/2-13-Quadruple-Color-ePaper-Display-with-122x250-Pixels-p-5779.html) | 250 × 122<br><small>131 PPI</small> | Quad Color | <Badge>24 pin</Badge> | <Badge tone="error">No</Badge> | <Badge tone="ok">Yes</Badge><br><small>Setup as 128 × 250 ID: 52</small> |
| [2.9" Flexible Monochrome ePaper Display](https://www.seeedstudio.com/2-9-Flexible-Monochrome-ePaper-Display-with-296x128-Pixels-p-5780.html) | 296 × 128<br><small>111 PPI</small> | Monochrome | <Badge>24 pin</Badge> | <Badge tone="error">No</Badge> | <Badge tone="ok">Yes</Badge><br><small>ID: 23</small> |
| [2.9" Monochrome ePaper Display](https://www.seeedstudio.com/2-9-Monochrome-ePaper-Display-with-296x128-Pixels-p-5782.html) | 296 × 128<br><small>111 PPI</small> | Monochrome | <Badge>24 pin</Badge> | <Badge tone="ok">Yes</Badge> | <Badge tone="ok">Yes</Badge><br><small>ID: 5</small> |
| [2.9" Quadruple Color ePaper Display](https://www.seeedstudio.com/2-9-Quadruple-Color-ePaper-Display-with-128x296-Pixels-p-5783.html) | 296 × 128<br><small>111 PPI</small> | Quad Color | <Badge>24 pin</Badge> | <Badge tone="error">No</Badge> | <Badge tone="ok">Yes</Badge><br><small>ID: 29</small> |
| [4.2" Monochrome ePaper Display](https://www.seeedstudio.com/4-2-Monochrome-ePaper-Display-with-400x300-Pixels-p-5784.html) | 400 × 300<br><small>119 PPI</small> | Monochrome | <Badge>24 pin</Badge> | <Badge tone="ok">Yes</Badge> | <Badge tone="ok">Yes</Badge><br><small>ID: 2</small> |
| [4.26" Monochrome ePaper Display](https://www.seeedstudio.com/4-26-Monochrome-SPI-ePaper-Display-p-6398.html) | 800 × 480<br><small>219 PPI</small> | Monochrome | <Badge>24 pin</Badge> | <Badge tone="error">No</Badge> | <Badge tone="ok">Yes</Badge><br><small>ID: 39</small> |
| [5.83" Monochrome ePaper Display](https://www.seeedstudio.com/5-83-Monochrome-ePaper-Display-with-648x480-Pixels-p-5785.html) | 648 × 480<br><small>138 PPI</small> | Monochrome | <Badge>24 pin</Badge> | <Badge tone="ok">Yes</Badge> | <Badge tone="ok">Yes</Badge><br><small>ID: 31</small> |
| [7.3" Spectra™ 6 Color ePaper Display](https://www.seeedstudio.com/7-3inch-Six-Color-eInk-ePaper-Display-with-800x480-Pixels-p-6567.html) | 800 × 480<br><small>128 PPI</small> | 6 Color | <Badge>50 pin</Badge> | <Badge tone="error">No</Badge> | <Badge tone="ok">Yes</Badge><br><small>ID: 35</small> |
| [7.5" Monochrome ePaper Display](https://www.seeedstudio.com/7-5-Monochrome-ePaper-Display-with-800x480-Pixels-p-5788.html) | 800 × 480<br><small>124 PPI</small> | Monochrome | <Badge>24 pin</Badge> | <Badge tone="ok">Yes</Badge> | <Badge tone="ok">Yes</Badge><br><small>ID: 59</small> |
| [10.3" Monochrome ePaper Display](https://www.seeedstudio.com/10-3inch-Monochrome-eInk-ePaper-Display-with-1404x1872-Pixels-p-6568.html) | 1404 × 1872<br><small>227 PPI</small> | Monochrome | <Badge>40 pin</Badge> | <Badge tone="ok">Yes</Badge> | <Badge tone="ok">Yes</Badge><br><small>ID: 3000</small> |
| [13.3" Spectra™ 6 Color ePaper Display](https://www.seeedstudio.com/13-3inch-Six-Color-eInk-ePaper-Display-with-1200x1600-Pixels-p-6569.html) | 1600 × 1200<br><small>150 PPI</small> | 6 Color | <Badge>60 pin</Badge> | <Badge tone="error">No</Badge> | <Badge tone="warn">Maybe</Badge><br><small>Other connector</small> |

## Compatible Driver Boards

The following driver boards are compatible with Seeed Studio ePaper displays based on their connector type:

| Connector Type | Compatible Driver Boards |
| --- | --- |
| <Badge>24 pin</Badge> | [EN04](https://www.seeedstudio.com/XIAO-ePaper-Display-Board-nRF52840-EN04-p-6589.html), [EE04](https://www.seeedstudio.com/XIAO-ePaper-Display-Board-EE04-p-6560.html),[EN05](https://www.seeedstudio.com/XIAO-ePaper-DIY-Kit-nRF52840-EN05.html), [EE05](https://www.seeedstudio.com/XIAO-ePaper-DIY-Kit-ESP32-S3-EE05.html),[ePaper Driver Board for Seeed Studio XIAO](https://www.seeedstudio.com/ePaper-breakout-Board-for-XIAO-V2-p-6374.html) |
| <Badge>50 pin</Badge> | [EN04](https://www.seeedstudio.com/XIAO-ePaper-Display-Board-nRF52840-EN04-p-6589.html), [EE04](https://www.seeedstudio.com/XIAO-ePaper-Display-Board-EE04-p-6560.html) |
| <Badge>60 pin</Badge> | [EE02](https://www.seeedstudio.com/XIAO-ePaper-Display-Board-ESP32-S3-EE02-p-6639.html) |
| <Badge>40 pin</Badge> | EE03 |
