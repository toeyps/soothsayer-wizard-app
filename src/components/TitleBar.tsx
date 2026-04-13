import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Sun, Moon, Save } from "lucide-react";

const isMacOS = navigator.userAgent.includes("Mac");

interface TitleBarProps {
  theme: "light" | "dark";
  toggleTheme: () => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  workspaceName?: string;
  onRename?: (newName: string) => void;
}

export default function TitleBar({
  theme,
  toggleTheme,
  onSave,
  onSaveAs,
  workspaceName,
  onRename,
}: TitleBarProps) {
  const appWindow = getCurrentWindow();
  const [isEditing, setIsEditing] = useState(false);
  const [tempName, setTempName] = useState(workspaceName || "");
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const saveMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTempName(workspaceName || "");
  }, [workspaceName]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        saveMenuRef.current &&
        !saveMenuRef.current.contains(event.target as Node)
      ) {
        setShowSaveMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
          Soothsayer-Wizard
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
        {onSave && (
          <div style={{ position: "relative" }} ref={saveMenuRef}>
            <button
              className="titlebar-button"
              onClick={() => setShowSaveMenu(!showSaveMenu)}
              title="Workspace Options"
              style={{ color: "var(--accent-color)" }}
            >
              <Save size={16} />
            </button>
            {showSaveMenu && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  background: "var(--card-bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
                  padding: "4px",
                  minWidth: "120px",
                  zIndex: 1000,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <button
                  className="menu-item"
                  onClick={() => {
                    onSave();
                    setShowSaveMenu(false);
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--text-primary)",
                    padding: "8px 12px",
                    textAlign: "left",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                    borderRadius: "4px",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "var(--hover-bg)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  1. Save
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    if (onSaveAs) onSaveAs();
                    setShowSaveMenu(false);
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--text-primary)",
                    padding: "8px 12px",
                    textAlign: "left",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                    borderRadius: "4px",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "var(--hover-bg)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  2. Save As...
                </button>
              </div>
            )}
          </div>
        )}
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
