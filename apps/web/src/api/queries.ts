import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Message } from "@muster/shared";
import { api } from "./client";
import { mergeMessageSnapshot } from "./realtime";

export const useTodos = () =>
  useQuery({ queryKey: ["todos"], queryFn: api.todos });
export const useProjects = () =>
  useQuery({ queryKey: ["projects"], queryFn: api.projects });
export const useAgents = () =>
  useQuery({ queryKey: ["agents"], queryFn: api.agents });
export const useProject = (id: string) =>
  useQuery({ queryKey: ["projects", id], queryFn: () => api.project(id), enabled: !!id });
export const useTopic = (id: string | undefined) =>
  useQuery({ queryKey: ["topics", id], queryFn: () => api.topic(id!), enabled: !!id });
export const useTodo = (id: string) =>
  useQuery({
    queryKey: ["todo", id],
    queryFn: () => api.todo(id),
    enabled: !!id,
  });
export function useMessages(id: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ["messages", id],
    queryFn: async ({ signal }) => {
      const snapshot = await api.messages(id, signal);
      return mergeMessageSnapshot(
        snapshot,
        client.getQueryData<Message[]>(["stream-buffer", id]),
      );
    },
    enabled: !!id,
    staleTime: Infinity,
  });
}

export const useMachines = () =>
  useQuery({ queryKey: ["machines"], queryFn: api.machines, refetchInterval: 10_000 });
