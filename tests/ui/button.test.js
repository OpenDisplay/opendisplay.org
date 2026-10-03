// @vitest-environment jsdom
import { flushSync, mount, unmount, createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Button from '../../src/lib/ui/Button.svelte';

const label = (text) => createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

let component;
function render(props) {
  document.body.innerHTML = '';
  component = mount(Button, { target: document.body, props: { children: label('Write config'), ...props } });
  flushSync();
  return document.querySelector('button');
}
const shown = () => document.querySelector('.label.shown').textContent;

afterEach(() => {
  if (component) unmount(component);
  vi.useRealTimers();
});

describe('Button', () => {
  it('renders a link without states when given href', () => {
    document.body.innerHTML = '';
    component = mount(Button, { target: document.body, props: { href: '/firmware/toolbox/', children: label('Open') } });
    expect(document.querySelector('a').getAttribute('href')).toBe('/firmware/toolbox/');
    expect(document.querySelector('button')).toBeNull();
  });

  it('goes busy while the click promise runs, then done, then back to idle', async () => {
    vi.useFakeTimers();
    let finish;
    const button = render({ onclick: () => new Promise((resolve) => (finish = resolve)), busyLabel: 'Writing…', doneLabel: 'Saved' });

    button.click();
    flushSync();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(shown()).toBe('Writing…');

    finish();
    await vi.runAllTicks();
    await Promise.resolve();
    flushSync();
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(shown()).toBe('Saved');
    expect(document.querySelector('[aria-live]').textContent).toBe('Saved');

    vi.advanceTimersByTime(2000);
    flushSync();
    expect(shown()).toBe('Write config');
  });

  it('shows failed when the click promise rejects', async () => {
    const button = render({ onclick: () => Promise.reject(new Error('no answer')), failedLabel: 'Failed' });
    button.click();
    await new Promise((r) => setTimeout(r));
    flushSync();
    expect(button.classList.contains('failed')).toBe(true);
    expect(shown()).toBe('Failed');
  });

  it('ignores clicks while busy, so an action never runs twice', async () => {
    const onclick = vi.fn(() => new Promise(() => {}));
    const button = render({ onclick });
    button.click();
    flushSync();
    button.click();
    button.click();
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it('shows progress as a percentage in the busy label', () => {
    render({ state: 'busy', progress: 42.4, busyLabel: 'Uploading' });
    expect(shown()).toBe('Uploading 42%');
    expect(document.querySelector('button').style.getPropertyValue('--progress')).toBe('42.4%');
  });

  it('stays a plain button when onclick returns nothing', () => {
    const button = render({ onclick: () => {} });
    button.click();
    flushSync();
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(shown()).toBe('Write config');
  });
});
