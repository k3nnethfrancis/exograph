import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { terminalRenderStabilityIssues } from "./terminalRenderStability";

export interface LatencySummary {
  max: number;
  p50: number;
  p90: number;
  p99: number;
  samples: number[];
}

export function latencySummary(samples: number[]): LatencySummary {
  if (samples.length === 0) {
    throw new Error("Cannot summarize empty latency samples.");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    samples,
  };
}

export async function waitForTerminalText(page: Page, text: string, timeout = 5_000): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll(".xterm-rows")).some((rows) => rows.textContent?.includes(expected) ?? false),
    text,
    { timeout, polling: 10 },
  );
}

export async function waitForTerminalInputEnabled(page: Page, timeout = 5_000): Promise<void> {
  await expect
    .poll(
      async () => page.getByTestId("terminal-surface").evaluate((element) => element.className),
      { timeout },
    )
    .not.toContain("terminal-surface--input-disabled");
}

export async function visibleTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => Array.from(document.querySelectorAll(".xterm-rows")).map((rows) => rows.textContent ?? "").join("\n"));
}

export async function scrollTerminalToTop(page: Page): Promise<void> {
  await page.getByTestId("terminal-surface").hover();
  await page.mouse.wheel(0, -50_000);
}

export async function scrollTerminalToBottom(page: Page): Promise<void> {
  await page.getByTestId("terminal-surface").hover();
  await page.mouse.wheel(0, 50_000);
}

export async function expectTerminalRenderStable(page: Page): Promise<void> {
  const visibleText = await visibleTerminalText(page);
  const sessionText = await page.evaluate(async () => {
    const sessions = await window.exograph.terminals.list();
    const shell = sessions.find((session) => session.kind === "shell");
    return shell ? await window.exograph.terminals.read(shell.id) : "";
  });

  expect(
    terminalRenderStabilityIssues(sessionText, {
      requireExpectedFragments: true,
    }),
    `terminal render stability session text failed:\n${sessionText}`,
  ).toEqual([]);
  expect(
    terminalRenderStabilityIssues(visibleText, {
      requireVisibleFragments: true,
    }),
    `terminal render stability visible text failed:\n${visibleText}`,
  ).toEqual([]);
}

export async function expectTerminalRenderHistoryStable(page: Page): Promise<void> {
  await scrollTerminalToTop(page);
  await expect
    .poll(
      async () =>
        terminalRenderStabilityIssues(await visibleTerminalText(page), {
          requireVisibleHistoryFragments: true,
        }),
      { timeout: 5_000 },
    )
    .toEqual([]);

  const scrolledHistoryText = await visibleTerminalText(page);
  expect(
    terminalRenderStabilityIssues(scrolledHistoryText),
    `terminal render stability scrolled history failed:\n${scrolledHistoryText}`,
  ).toEqual([]);

  await scrollTerminalToBottom(page);
  await expect
    .poll(
      async () =>
        terminalRenderStabilityIssues(await visibleTerminalText(page), {
          requireVisibleFragments: true,
        }),
      { timeout: 5_000 },
    )
    .toEqual([]);
}

function percentile(sortedSamples: number[], percentileValue: number): number {
  const index = Math.min(sortedSamples.length - 1, Math.ceil(sortedSamples.length * percentileValue) - 1);
  return sortedSamples[Math.max(0, index)];
}
