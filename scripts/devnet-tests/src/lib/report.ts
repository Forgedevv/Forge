/**
 * Markdown report writer. Reports contain only public data: addresses, signatures, amounts.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PublicKey } from '@solana/web3.js';
import { REPORTS_DIR } from './env.js';
import { solscanAccount, solscanTx } from './solana.js';
import { lamportsToSol } from './math.js';

export class Report {
  private lines: string[] = [];

  constructor(title: string) {
    this.lines.push(`# ${title}`, '', `_Generated ${new Date().toISOString()} — devnet only._`, '');
  }

  h2(text: string): this {
    this.lines.push(`## ${text}`, '');
    return this;
  }

  p(text: string): this {
    this.lines.push(text, '');
    return this;
  }

  bullet(text: string): this {
    this.lines.push(`- ${text}`);
    return this;
  }

  blank(): this {
    this.lines.push('');
    return this;
  }

  code(text: string): this {
    this.lines.push('```', text, '```', '');
    return this;
  }

  table(headers: string[], rows: string[][]): this {
    this.lines.push(`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`);
    for (const row of rows) this.lines.push(`| ${row.join(' | ')} |`);
    this.lines.push('');
    return this;
  }

  verdict(ok: boolean, text: string): this {
    this.lines.push(`**Result: ${ok ? 'PASS' : 'FAIL'}** — ${text}`, '');
    return this;
  }

  toString(): string {
    return this.lines.join('\n') + '\n';
  }

  write(fileName: string): string {
    if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
    const path = resolve(REPORTS_DIR, fileName);
    writeFileSync(path, this.toString(), 'utf8');
    console.log(`Report written: ${path}`);
    return path;
  }
}

export function txLink(signature: string, label = 'tx'): string {
  return `[${label} ${signature.slice(0, 8)}…](${solscanTx(signature)})`;
}

export function accountLink(address: PublicKey | string, label?: string): string {
  const s = address.toString();
  return `[${label ?? s.slice(0, 8) + '…'}](${solscanAccount(s)})`;
}

export function sol(lamports: bigint | string | number): string {
  const v = BigInt(lamports);
  return `${v.toString()} lamports (${lamportsToSol(v)} SOL)`;
}
