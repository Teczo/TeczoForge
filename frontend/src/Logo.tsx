import { useState } from "react";
import { CubeIcon } from "./Icons";

// The TeczoForge logo. Put the logo picture at frontend/public/logo.png.
// Until that file exists, a drawn cube and the name are shown instead.
export default function Logo() {
  const [hasFile, setHasFile] = useState(true);

  if (hasFile) {
    return (
      <div className="logo">
        <img src="/logo.png" alt="TeczoForge" onError={() => setHasFile(false)} />
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
