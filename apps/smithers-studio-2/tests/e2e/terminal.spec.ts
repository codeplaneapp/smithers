import { test, expect, Page } from '@playwright/test';

test.describe('Terminal Integration', () => {
  test('creates PTY session and displays shell output', async ({ page }) => {
    await page.goto('/');

    // Wait for terminal to initialize and connect
    await page.waitForSelector('.ghostty-terminal', { timeout: 10000 });

    // Should show terminal status as attached once PTY connects
    await expect(page.locator('[data-testid="terminal-status"]')).toHaveText(/attached|connected/i, { timeout: 5000 });

    // Type a simple command and verify output
    await page.locator('.ghostty-terminal').click();
    await page.keyboard.type('echo "hello terminal"');
    await page.keyboard.press('Enter');

    // Verify command echo and output appear
    await expect(page.locator('.ghostty-terminal')).toContainText('echo "hello terminal"', { timeout: 3000 });
    await expect(page.locator('.ghostty-terminal')).toContainText('hello terminal', { timeout: 3000 });
  });

  test('handles PTY session lifecycle correctly', async ({ page }) => {
    await page.goto('/');

    // Wait for terminal connection
    await page.waitForSelector('.ghostty-terminal');
    await expect(page.locator('[data-testid="terminal-status"]')).toHaveText(/attached|connected/i, { timeout: 5000 });

    // Test input handling
    await page.locator('.ghostty-terminal').click();
    await page.keyboard.type('pwd');
    await page.keyboard.press('Enter');

    // Should see current directory output
    await expect(page.locator('.ghostty-terminal')).toContainText(/\/.*/, { timeout: 3000 });
  });

  test('handles terminal resize properly', async ({ page }) => {
    await page.goto('/');

    // Wait for terminal to load
    await page.waitForSelector('.ghostty-terminal');
    await expect(page.locator('[data-testid="terminal-status"]')).toHaveText(/attached|connected/i, { timeout: 5000 });

    // Get initial terminal size
    const terminalElement = page.locator('.ghostty-terminal');
    await terminalElement.click();

    // Test resize by running stty to check terminal size
    await page.keyboard.type('stty size');
    await page.keyboard.press('Enter');

    // Should show some terminal dimensions
    await expect(terminalElement).toContainText(/\d+ \d+/, { timeout: 3000 });

    // Resize the browser window
    await page.setViewportSize({ width: 1200, height: 900 });

    // Wait for potential resize event and run stty again
    await page.waitForTimeout(500);
    await page.keyboard.type('stty size');
    await page.keyboard.press('Enter');

    // Should still get valid dimensions (verifies resize doesn't break PTY)
    await expect(terminalElement).toContainText(/\d+ \d+/, { timeout: 3000 });
  });

  test('handles multiple terminal tabs with isolation', async ({ page }) => {
    await page.goto('/');

    // Wait for first terminal
    await page.waitForSelector('.ghostty-terminal');
    await expect(page.locator('[data-testid="terminal-status"]')).toHaveText(/attached|connected/i, { timeout: 5000 });

    // Open command palette to create new terminal
    await page.keyboard.press('Meta+k'); // Or Ctrl+k on Linux
    await page.waitForSelector('[data-testid="command-palette"]', { timeout: 3000 });
    await page.keyboard.type('New Terminal');
    await page.keyboard.press('Enter');

    // Should now have 2 terminal tabs
    await expect(page.locator('[data-testid="terminal-tab"]')).toHaveCount(2);

    // Type different commands in each tab to verify isolation
    await page.locator('.ghostty-terminal').click();
    await page.keyboard.type('echo "tab2"');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ghostty-terminal')).toContainText('tab2', { timeout: 3000 });

    // Switch to first tab
    await page.locator('[data-testid="terminal-tab"]').first().click();
    await page.locator('.ghostty-terminal').click();
    await page.keyboard.type('echo "tab1"');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ghostty-terminal')).toContainText('tab1', { timeout: 3000 });

    // Verify first tab doesn't show content from second tab
    await expect(page.locator('.ghostty-terminal')).not.toContainText('tab2');
  });

  test('handles terminal close and cleanup', async ({ page }) => {
    await page.goto('/');

    // Wait for terminal
    await page.waitForSelector('.ghostty-terminal');
    await expect(page.locator('[data-testid="terminal-status"]')).toHaveText(/attached|connected/i, { timeout: 5000 });

    // Create a second terminal so we can close one
    await page.keyboard.press('Meta+k');
    await page.waitForSelector('[data-testid="command-palette"]', { timeout: 3000 });
    await page.keyboard.type('New Terminal');
    await page.keyboard.press('Enter');

    // Should have 2 tabs
    await expect(page.locator('[data-testid="terminal-tab"]')).toHaveCount(2);

    // Close the current tab
    await page.locator('[data-testid="close-terminal"]').click();

    // Should now have 1 tab
    await expect(page.locator('[data-testid="terminal-tab"]')).toHaveCount(1);

    // Remaining terminal should still work
    await page.locator('.ghostty-terminal').click();
    await page.keyboard.type('echo "still works"');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ghostty-terminal')).toContainText('still works', { timeout: 3000 });
  });

  test('displays process exit status correctly', async ({ page }) => {
    await page.goto('/');

    // Wait for terminal
    await page.waitForSelector('.ghostty-terminal');
    await expect(page.locator('[data-testid="terminal-status"]')).toHaveText(/attached|connected/i, { timeout: 5000 });

    // Run a command that exits with non-zero code
    await page.locator('.ghostty-terminal').click();
    await page.keyboard.type('exit 42');
    await page.keyboard.press('Enter');

    // Should show process exited message
    await expect(page.locator('.ghostty-terminal')).toContainText(/process exited with code 42/, { timeout: 5000 });

    // Terminal status should reflect exit
    await expect(page.locator('[data-testid="terminal-status"]')).toHaveText(/exited|ended/i, { timeout: 3000 });
  });

  test('handles PTY server unavailable gracefully', async ({ page }) => {
    // This test simulates the PTY server being unavailable
    // by intercepting the WebSocket connection
    await page.route('**/terminal/ws', route => {
      route.abort('connectionrefused');
    });

    await page.goto('/');

    // Should show PTY server unavailable message
    await expect(page.locator('.terminal-status')).toContainText(/PTY server unavailable/, { timeout: 5000 });

    // Should still show the terminal component structure
    await expect(page.locator('.terminal-pane')).toBeVisible();
  });

  test('maintains scrollback across session', async ({ page }) => {
    await page.goto('/');

    // Wait for terminal
    await page.waitForSelector('.ghostty-terminal');
    await expect(page.locator('[data-testid="terminal-status"]')).toHaveText(/attached|connected/i, { timeout: 5000 });

    // Generate multiple lines of output
    await page.locator('.ghostty-terminal').click();
    for (let i = 1; i <= 10; i++) {
      await page.keyboard.type(`echo "line ${i}"`);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100); // Small delay between commands
    }

    // Verify we can see multiple lines in scrollback
    await expect(page.locator('.ghostty-terminal')).toContainText('line 1', { timeout: 3000 });
    await expect(page.locator('.ghostty-terminal')).toContainText('line 10', { timeout: 3000 });

    // Test scrolling behavior
    await page.locator('.ghostty-terminal').press('PageUp');
    await page.waitForTimeout(500);

    // Should still be able to see earlier content
    await expect(page.locator('.ghostty-terminal')).toContainText('line 1');
  });
});