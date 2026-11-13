import { useState } from "react";
import { Box } from "lucide-react";

// The TeczoForge logo: the "Teczo Forge" logo picture (frontend/public/logo.png).
// If the picture is missing, a drawn cube and the name are shown instead.
export default function Logo() {
  const [hasFile, setHasFile] = useState(true);

  if (hasFile) {
    return (
      <div className="logo">
        <img src="/logo.png" alt="Teczo Forge" onError={() => setHasFile(false)} />
      </div>
    );
  }
  return (
    <div className="logo">
      <Box size={38} className="logo-mark" />
      <span>
        <span className="logo-word-1">teczo</span>
        <span className="logo-word-2">Forge</span>
      </span>
    </div>
  );
}
