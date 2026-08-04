// Derived from millionco/react-doctor rule regression fixtures under the owner's grant.
import lodash from "lodash";
import moment from "moment";
import {
  Dimensions as WindowDimensions,
  FlatList as NativeList,
  TouchableOpacity as LegacyButton,
} from "react-native";

export function ReleasePackPositive({ rows, html, input }) {
  WindowDimensions.get("window");
  localStorage.setItem("access_token", input);
  eval(input);

  return (
    <>
      <img src="avatar.png" />
      <iframe src="https://third-party.example" />
      <NativeList renderItem={({ item }) => <span>{item.name}</span>} />
      <LegacyButton />
      {rows.map((row, index) => <span key={index}>{row.name}</span>)}
      <section dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

void lodash;
void moment;
