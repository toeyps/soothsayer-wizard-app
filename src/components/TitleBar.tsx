import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { useIsMacOS } from "../hooks/useIsMacOS";
import { debugLog } from "../utils/debugLog";

interface TitleBarProps {
  workspaceName?: string;
  onRename?: (newName: string) => void;
  // Increments when the app menu's "Rename Workspace" is invoked; entering edit mode here.
  renameTrigger?: number;
  /** Given: the project name is a menu button ("Rename…" / "Project details…",
   *  both open Project details — the name is "Plant · Machine") and the app
   *  menu's Rename Workspace opens Project details too. */
  onOpenDetails?: () => void;
}

export default function TitleBar({
  workspaceName,
  onRename,
  renameTrigger,
  onOpenDetails,
}: TitleBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const projBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuItems = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  // Opening the menu focuses its first item.
  useEffect(() => { if (menuOpen) menuItems()[0]?.focus(); }, [menuOpen]);
  // A click anywhere else closes it.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuOpen]);
  const closeMenu = (refocus: boolean) => {
    setMenuOpen(false);
    if (refocus) projBtnRef.current?.focus();
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = menuItems();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
  };
  // The dialog returns focus to whatever had it when it opened: the project
  // button, not the menu item that disappears with the menu.
  const pickDetails = () => {
    closeMenu(true);
    onOpenDetails?.();
  };
  const appWindow = getCurrentWindow();
  const isMacOS = useIsMacOS();
  const [isEditing, setIsEditing] = useState(false);
  const [tempName, setTempName] = useState(workspaceName || "");

  useEffect(() => {
    setTempName(workspaceName || "");
  }, [workspaceName]);

  // App menu > Rename Workspace. Acts once per trigger (a later rename must not
  // re-open anything just because the name changed).
  const handledTriggerRef = useRef(renameTrigger ?? 0);
  useEffect(() => {
    if (!renameTrigger || renameTrigger === handledTriggerRef.current || workspaceName === undefined) return;
    handledTriggerRef.current = renameTrigger;
    if (onOpenDetails) onOpenDetails();
    else setIsEditing(true);
  }, [renameTrigger, workspaceName, onOpenDetails]);

  const handleBlur = () => {
    setIsEditing(false);
    if (onRename && tempName.trim() !== "" && tempName !== workspaceName) {
      onRename(tempName);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleBlur();
    } else if (e.key === "Escape") {
      setIsEditing(false);
      setTempName(workspaceName || "");
    }
  };

  return (
    <div className={`titlebar ${isMacOS ? "macos" : ""}`}>
      <div className="titlebar-drag-region" data-tauri-drag-region>
        <span
          style={{ marginRight: "1rem", opacity: 0.7, pointerEvents: "none" }}
        >
          Wizard
        </span>
        {workspaceName !== undefined && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              pointerEvents: "auto",
            }}
          >
            <span style={{ fontSize: "0.75rem", opacity: 0.5 }}>
              Project:
            </span>
            {onOpenDetails ? (
              <span style={{ position: "relative" }}>
                <button
                  ref={projBtnRef}
                  type="button"
                  className="tb-proj"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  title="Rename or edit the project details"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  {workspaceName || "Unnamed project"} <span aria-hidden="true" className="tb-caret">▾</span>
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    aria-label="Project"
                    ref={menuRef}
                    className="tb-menu"
                    onKeyDown={onMenuKey}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <button type="button" role="menuitem" onClick={pickDetails}>
                      Rename…<small>Plant · Machine</small>
                    </button>
                    <button type="button" role="menuitem" onClick={pickDetails}>
                      Project details…<small>Plant, machine, tag, notes, time zone</small>
                    </button>
                  </div>
                )}
              </span>
            ) : isEditing ? (
              <input
                autoFocus
                value={tempName}
                onChange={(e) => setTempName(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                style={{
                  background: "var(--input-bg)",
                  border: "1px solid var(--accent-color)",
                  color: "var(--text-primary)",
                  fontSize: "0.85rem",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  outline: "none",
                  minWidth: "200px",
                }}
              />
            ) : (
              <span
                onClick={() => setIsEditing(true)}
                style={{
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  border: "1px solid transparent",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.borderColor = "var(--border)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.borderColor = "transparent")
                }
              >
                {workspaceName || "Unnamed project"}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="titlebar-actions">
        {/* Window controls: only shown on non-macOS (macOS uses native traffic lights) */}
        {!isMacOS && (
          <>
            <button
              className="titlebar-button"
              onClick={() => {
                debugLog("minimize");
                appWindow.minimize();
              }}
            >
              <Minus size={16} />
            </button>
            <button
              className="titlebar-button"
              onClick={() => {
                debugLog("maximize");
                appWindow.toggleMaximize();
              }}
            >
              <Square size={14} />
            </button>
            <button
              className="titlebar-button close"
              onClick={() => {
                debugLog("close");
                appWindow.close();
              }}
            >
              <X size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
