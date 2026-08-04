// Derived from millionco/react-doctor rule regression fixtures under the owner's grant.
import type { LoDashStatic } from "lodash";
import type Moment from "moment";
import { Dimensions as WindowDimensions } from "react-native";

const sandbox = { eval(value: string) { return value; } };
const Dimensions = { get() { return 320; } };

export function ReleasePackNegative({ rows, props, html, csrfToken }) {
  localStorage.setItem("csrf_token", csrfToken);
  sandbox.eval("data");
  Dimensions.get();
  const width = WindowDimensions.get("window").width;

  return (
    <>
      <img alt="Profile photo" src="avatar.png" />
      <img aria-hidden="true" src="decoration.png" />
      <img {...props} src="generated.png" />
      <iframe sandbox="allow-scripts" src="https://trusted.example" />
      <iframe {...props} src="about:blank" />
      {rows.map((row) => <span key={row.id}>{row.name}</span>)}
      <section dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />
      <output>{width}</output>
    </>
  );
}

type References = LoDashStatic | Moment;
