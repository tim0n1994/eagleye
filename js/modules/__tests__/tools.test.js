import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderToolBySlug } from '../tools.js';

describe('renderToolBySlug', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('renders HTML content for a known slug', () => {
    renderToolBySlug('json-formatter', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('JSON Formatter');
  });

  it('renders different tools based on slug', () => {
    renderToolBySlug('password-generator', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('Password Generator');
  });

  it('renders QR Generator for qr-generator slug', () => {
    renderToolBySlug('qr-generator', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('QR Generator');
  });

  it('renders Color Picker for color-picker slug', () => {
    renderToolBySlug('color-picker', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('Color Picker');
  });

  it('renders Markdown Preview for markdown-preview slug', () => {
    renderToolBySlug('markdown-preview', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('Markdown Preview');
  });

  it('renders code-minifier', () => {
    renderToolBySlug('code-minifier', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('Code Minifier');
  });

  it('renders mortgage-calculator', () => {
    renderToolBySlug('mortgage-calculator', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('Mortgage Calculator');
  });

  it('renders unit-converter', () => {
    renderToolBySlug('unit-converter', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('Unit Converter');
  });

  it('renders chronograph', () => {
    renderToolBySlug('chronograph', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('Chronograph');
  });

  it('renders ip-lookup', () => {
    renderToolBySlug('ip-lookup', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('IP Lookup');
  });

  it('renders image-compressor', () => {
    renderToolBySlug('image-compressor', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('Image Compressor');
  });

  it('renders leverage-calculator', () => {
    renderToolBySlug('leverage-calculator', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('Leverage Calculator');
  });

  it('renders heloc-calculator', () => {
    renderToolBySlug('heloc-calculator', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('HELOC Calculator');
  });

  it('renders 2fa-authenticator', () => {
    renderToolBySlug('2fa-authenticator', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('2FA Authenticator');
  });

  it('renders base64-encoder', () => {
    renderToolBySlug('base64-encoder', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('Base64 Encoder');
  });

  it('renders JSON Diff for json-formatter-alt slug', () => {
    renderToolBySlug('json-formatter-alt', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('JSON Diff');
  });

  it('renders screenshot-beautify', () => {
    renderToolBySlug('screenshot-beautify', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('Screenshot Beautify');
  });

  it('renders zip-creator', () => {
    renderToolBySlug('zip-creator', container);
    const html = container.innerHTML;
    expect(html).toContain('TOOL');
    expect(html).toContain('ZIP Creator');
  });

  it('shows "not found" for unknown slug', () => {
    renderToolBySlug('nonexistent-tool', container);
    const html = container.innerHTML;
    expect(html).toContain('Tool not found');
    expect(html).toContain('nonexistent-tool');
    expect(html).toContain('← All Tools');
  });

  it('includes badge indicators in tool output', () => {
    renderToolBySlug('json-formatter', container);
    const html = container.innerHTML;
    expect(html).toContain('LOCAL');
    expect(html).toContain('NO UPLOAD');
    expect(html).toContain('NO LOGIN');
  });

  it('renders page-section wrapper for every tool', () => {
    renderToolBySlug('json-formatter', container);
    expect(container.querySelector('.page-section')).toBeTruthy();
    expect(container.querySelector('.page-title')).toBeTruthy();
  });

  it('renders tool-interactive div for every tool', () => {
    renderToolBySlug('json-formatter', container);
    expect(container.querySelector('.tool-interactive')).toBeTruthy();
  });
});
