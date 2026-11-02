import { useEffect } from "react";
import { useLocation } from "react-router";
import { useProjects, useTodos } from "../api/queries";
import { useStored } from "./usePreferences";

/** The workspace the user is in: the routed one (directly or through a task), else the last one opened, else the first. */
export function useCurrentWorkspaceId(): string | undefined {
  const { pathname } = useLocation();
  const projects = useProjects();
  const todos = useTodos();
  const [last, setLast] = useStored<string | null>("last-workspace", null);
  const todoId = pathname.match(/^\/todos\/([^/]+)/)?.[1];
  const routed = pathname.match(/^\/w\/([^/]+)/)?.[1] ?? todos.data?.find((todo) => todo.id === todoId)?.projectId;
  useEffect(() => {
    if (routed && routed !== last) setLast(routed);
  }, [routed, last, setLast]);
  if (routed) return routed;
  const list = projects.data ?? [];
  return list.find((project) => project.id === last)?.id ?? list[0]?.id;
}
