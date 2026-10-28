/**
 * Cross-zone: Rust's 10 MB refusal for a tag-name (mapping) CSV
 * (`MAX_SIDE_CSV_BYTES`, csv_processor.rs `check_side_csv_size`, 2026-10-28)
 * must reach the user verbatim through the REAL `useMappingData` hook and the
 * REAL `TagNamesPanel`.
 *
 * Tauri rejects `invoke` with the bare Rust `Err(String)` — a plain string,
 * not an `Error` — so this test rejects with a string exactly as the command
 * does. The hook's own unit test only covers an `Error` object, and the
 * panel's test only feeds a ready-made `mapping.error`, so neither alone
 * proves the message survives the trip (or that the panel still shows it
 * once the failed file has been cleared and the picker is back).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useMappingData } from '../hooks/useMappingData';
import TagNamesPanel from '../components/upload/TagNamesPanel';
import { DARK } from '../components/upload/uploadTheme';

const mockInvoke = vi.fn();
const mockOpen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}));

// Exactly the text csv_processor.rs builds for a 12.3 MB file.
const RUST_TOO_LARGE =
  'File too large: 12.3 MB (max 10 MB). This file should list one row per sensor.';

function Harness() {
  const mapping = useMappingData();
  return <TagNamesPanel T={DARK} locked={false} mapping={mapping} />;
}

describe('Tag-name CSV over 10 MB (Rust refusal → hook → panel)', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockOpen.mockReset();
  });

  it('shows the Rust "File too large" message word for word and keeps the picker available', async () => {
    mockOpen.mockResolvedValue('C:/data/huge-tags.csv');
    mockInvoke.mockRejectedValue(RUST_TOO_LARGE); // string, like a Tauri command Err

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Select tag-name CSV/ }));

    expect(await screen.findByText(RUST_TOO_LARGE)).toBeTruthy();
    expect(mockInvoke).toHaveBeenCalledWith('load_mapping_csv', { path: 'C:/data/huge-tags.csv' });
    // The refused file is not kept as the chosen one: the picker is back and
    // enabled, so the user can pick a smaller file straight away.
    const picker = screen.getByRole('button', { name: /Select tag-name CSV/ });
    expect((picker as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('huge-tags.csv')).toBeNull();
  });

  it('clears the message once a valid file is picked next', async () => {
    mockOpen.mockResolvedValueOnce('C:/data/huge-tags.csv').mockResolvedValueOnce('C:/data/tags.csv');
    mockInvoke
      .mockRejectedValueOnce(RUST_TOO_LARGE)
      .mockResolvedValueOnce({ headers: ['tag', 'description'], rows: [['A', 'Temp']] });

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Select tag-name CSV/ }));
    expect(await screen.findByText(RUST_TOO_LARGE)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Select tag-name CSV/ }));
    await waitFor(() => expect(screen.queryByText(RUST_TOO_LARGE)).toBeNull());
    expect(await screen.findByText('tags.csv')).toBeTruthy();
  });
});
