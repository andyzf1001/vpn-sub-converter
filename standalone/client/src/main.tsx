import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

// 独立版入口：平台版用的是 SDK 提供的 spaceQueryClient，这里换成
// 应用自己的 QueryClient，其余结构保持一致。
const queryClient = new QueryClient();

const rootEl = document.querySelector<HTMLElement>("[data-app-root]");
if (!rootEl) {
  throw new Error("missing app root element");
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
