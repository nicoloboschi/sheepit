import { describe, it, expect } from 'vitest';
import { applyCustomWords as fix, soundex } from './customWords';

// Cases from Handy's own tests (audio_toolkit/text.rs), same thresholds.
describe('custom words', () => {
  it('matches Handy', () => {
    expect(fix('hello world', ['Hello', 'World'], 0.5)).toBe('Hello World');
    expect(fix('helo wrold', ['hello', 'world'], 0.5)).toBe('hello world');
    expect(fix('hello world', [], 0.5)).toBe('hello world');
    const cb = fix('il cui nome è Charge B, che permette', ['ChargeBee'], 0.5);
    expect(cb).toContain('ChargeBee,');
    expect(cb).not.toContain('Charge B');
    expect(fix('use Chat G P T for this', ['ChatGPT'], 0.5)).toContain('ChatGPT');
    expect(fix('Open AI GPT model', ['OpenAI', 'GPT'], 0.5)).toBe('OpenAI GPT model');
    expect(fix('CHARGE B is great', ['ChargeBee'], 0.5)).toContain('CHARGEBEE');
    expect(fix('using Mac Book Pro', ['MacBook Pro'], 0.5)).toBe('using MacBook Pro');
    expect(fix('send it to RD for review', ['R&D'])).toBe('send it to R&D for review');
    expect(fix('send it to R and D for review', ['R&D'])).toBe('send it to R&D for review');
    expect(fix('send it to R&D for review', ['R&D'])).toBe('send it to R&D for review');
    expect(fix('「Handee。」', ['Handy'], 0.5)).toBe('「Handy。」');
    expect(fix('你好。', ['你号'], 1.0)).toBe('你好。');
  });
  it('soundex', () => {
    expect(soundex('robert')).toBe('R163');
    expect(soundex('rupert')).toBe('R163');
    expect(soundex('ashcraft')).toBe('A261');
    expect(soundex('tymczak')).toBe('T522');
  });
  it('the default threshold fixes the usual slips', () => {
    expect(fix('ask hind sight about it', ['Hindsight'])).toBe('ask Hindsight about it');
    expect(fix('ask claud about it', ['Claude'])).toBe('ask Claude about it');
    // Handy does this too: short words that sound alike are taken.
    expect(fix('make a cake', ['Ciak'])).toBe('make a Ciak');
  });
});
