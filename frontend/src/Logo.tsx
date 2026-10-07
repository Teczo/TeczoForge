import { useState } from "react";
import { CubeIcon } from "./Icons";

// The TeczoForge logo: the Teczo logo picture (frontend/public/logo.png) with "Forge" after it.
// If the picture is missing, a drawn cube and the name are shown instead.
export default function Logo() {
  const [hasFile, setHasFile] = useState(true);

  if (hasFile) {
    return (
      <div className="logo">
        <img src="/logo.png" alt="teczo" onError={() => setHasFile(false)} />
        <span className="logo-word-2 logo-forge">Forge</span>
      </div>
    );
  }
  return (
    <div className="logo">
      <CubeIcon size={38} className="logo-mark" />
      <span>
        <span className="logo-word-1">teczo</span>
        <span className="logo-word-2">Forge</span>
      </span>
    </div>
  );
}
