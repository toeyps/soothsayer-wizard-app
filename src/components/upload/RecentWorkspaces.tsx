import { useState, useEffect, useRef } from "react";
import { Layout, Clock, MoreVertical, Trash2, Copy, Edit2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { WorkspaceMetadata } from "../../types";
import {
  getRecentWorkspaces,
  deleteWorkspace,
  duplicateWorkspace,
  renameWorkspaceFile,
} from "../../workspaceManager";

interface RecentWorkspacesProps {
  onLoadWorkspace: (id: string) => void;
}

export default function RecentWorkspaces({ onLoadWorkspace }: RecentWorkspacesProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceMetadata[]>([]);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const refresh = () => {
    getRecentWorkspaces().then(setWorkspaces).catch(console.error);
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenuId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = await ask(
      "Are you sure you want to delete this workspace? This action cannot be undone.",
      { title: "Delete Workspace", kind: "warning" }
    );
    if (confirmed) {
      await deleteWorkspace(id);
      refresh();
      setActiveMenuId(null);
    }
  };

  const handleDuplicate = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await duplicateWorkspace(id);
    refresh();
    setActiveMenuId(null);
  };

  const handleRename = async (ws: WorkspaceMetadata, e: React.MouseEvent) => {
    e.stopPropagation();
    const newName = prompt("Rename workspace:", ws.name);
    if (newName && newName.trim() !== "" && newName !== ws.name) {
      await renameWorkspaceFile(ws.id, newName);
      refresh();
    }
    setActiveMenuId(null);
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return (
      d.toLocaleDateString() +
      " " +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
  };

  return (
    <div className="w-[280px] shrink-0 flex flex-col border-r border-neutral-800/60 bg-neutral-950/40 px-4 py-6 overflow-y-auto">
      <div className="flex items-center gap-2 mb-5 px-1">
        <Layout size={18} className="text-sky-400" />
        <h2 className="text-sm font-semibold tracking-wide text-neutral-200">
          Recent Workspaces
        </h2>
      </div>

      {workspaces.length === 0 ? (
        <div className="text-xs text-neutral-500 text-center border border-dashed border-neutral-700/50 rounded-xl py-6 px-3">
          No workspaces found.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              onClick={() => { if (!activeMenuId) onLoadWorkspace(ws.id); }}
              className={`relative flex flex-col rounded-xl px-3 py-2.5 cursor-pointer transition-all border ${
                activeMenuId === ws.id
                  ? "border-neutral-700 bg-neutral-800/50"
                  : "border-transparent hover:bg-neutral-800/30 hover:border-neutral-700/40"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-neutral-200 truncate flex-1">{ws.name}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveMenuId(activeMenuId === ws.id ? null : ws.id);
                  }}
                  className="text-neutral-500 hover:text-neutral-300 transition-colors p-0.5 cursor-pointer"
                >
                  <MoreVertical size={14} />
                </button>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-neutral-500 mt-1">
                <Clock size={10} />
                <span>{formatTime(ws.lastModified)}</span>
              </div>

              {activeMenuId === ws.id && (
                <div
                  ref={menuRef}
                  className="absolute top-10 right-2 z-50 bg-neutral-800/95 backdrop-blur-xl border border-neutral-700/60 rounded-xl shadow-2xl p-1 min-w-[140px]"
                >
                  <button type="button" onClick={(e) => handleRename(ws, e)}
                    className="flex items-center gap-2 w-full text-left text-xs text-neutral-300 hover:bg-neutral-700/50 rounded-lg px-3 py-2 transition-colors cursor-pointer">
                    <Edit2 size={12} /> Rename
                  </button>
                  <button type="button" onClick={(e) => handleDuplicate(ws.id, e)}
                    className="flex items-center gap-2 w-full text-left text-xs text-neutral-300 hover:bg-neutral-700/50 rounded-lg px-3 py-2 transition-colors cursor-pointer">
                    <Copy size={12} /> Duplicate
                  </button>
                  <div className="h-px bg-neutral-700/40 my-1" />
                  <button type="button" onClick={(e) => handleDelete(ws.id, e)}
                    className="flex items-center gap-2 w-full text-left text-xs text-red-400 hover:bg-red-950/40 rounded-lg px-3 py-2 transition-colors cursor-pointer">
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
