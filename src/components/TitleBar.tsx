import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Sun, Moon } from "lucide-react";
import { useIsMacOS } from "../hooks/useIsMacOS";

interface TitleBarProps {
  theme: "light" | "dark";
  toggleTheme: () => void;
  workspaceName?: string;
  onRename?: (newName: string) => void;
  // Increments when the app menu's "Rename Workspace" is invoked; entering edit mode here.
  renameTrigger?: number;
}

export default function TitleBar({
  theme,
  toggleTheme,
  workspaceName,
  onRename,
  renameTrigger,
}: TitleBarProps) {
  const appWindow = getCurrentWindow();
  const isMacOS = useIsMacOS();
  const [isEditing, setIsEditing] = useState(false);
  const [tempName, setTempName] = useState(workspaceName || "");

  useEffect(() => {
    setTempName(workspaceName || "");
  }, [workspaceName]);

  useEffect(() => {
    if (renameTrigger && workspaceName !== undefined) setIsEditing(true);
  }, [renameTrigger, workspaceName]);

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
              Workspace:
            </span>
            {isEditing ? (
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
                {workspaceName || "Unnamed Workspace"}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="titlebar-actions">
        <button
          className="titlebar-button"
          onClick={toggleTheme}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        {/* Window controls: only shown on non-macOS (macOS uses native traffic lights) */}
        {!isMacOS && (
          <>
            <div
              style={{
                width: "1px",
                height: "16px",
                background: "var(--border)",
                margin: "auto 0",
              }}
            ></div>
            <button
              className="titlebar-button"
              onClick={() => {
                console.log("minimize");
                appWindow.minimize();
              }}
            >
              <Minus size={16} />
            </button>
            <button
              className="titlebar-button"
              onClick={() => {
                console.log("maximize");
                appWindow.toggleMaximize();
              }}
            >
              <Square size={14} />
            </button>
            <button
              className="titlebar-button close"
              onClick={() => {
                console.log("close");
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
