/*
 * ふたりの家計簿 — 設定ファイル
 * Firebase コンソールの「プロジェクトの設定 > マイアプリ > SDK の設定と構成(構成)」に
 * 表示される firebaseConfig の中身を、下の firebase: { ... } に貼り付けてください。
 * 空のままだと「この端末だけに保存するお試しモード」で動きます。
 */
window.KAKEIBO_CONFIG = {
  firebase: {
    apiKey: "",
    authDomain: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: ""
  },

  /* レシート読み取り(任意)。README の「レシート読み取りを使う」を済ませてから true にします。 */
  receipt: {
    enabled: false,
    model: "gemini-3.5-flash",
    recaptchaSiteKey: ""
  }
};
