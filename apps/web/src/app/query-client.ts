import { notify } from "../components/Snackbar";
import { MutationCache, QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onSuccess: (_data, _variables, _context, mutation) => {
      if (typeof mutation.meta?.successNotice === "string") notify(mutation.meta.successNotice);
    },
    onError: (error, _variables, _context, mutation) => {
      if (typeof mutation.meta?.errorNotice === "string") {
        notify(error instanceof Error ? error.message : mutation.meta.errorNotice, "error");
      }
    },
  }),
  defaultOptions: { queries: { staleTime: 30_000, retry: 0 } },
});
