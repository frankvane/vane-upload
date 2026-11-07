import { useContext } from "react";
import { UploadContext, UploadContextType } from "./UploadContext";

export const useUploadContext = (): UploadContextType => {
  const context = useContext(UploadContext);
  if (context === undefined) {
    throw new Error("useUploadContext must be used within an UploadProvider");
  }
  return context;
};
