import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import uk.ac.cam.ch.wwmm.opsin.NameToStructure;
import uk.ac.cam.ch.wwmm.opsin.NameToStructureConfig;
import uk.ac.cam.ch.wwmm.opsin.OpsinResult;
import uk.ac.cam.ch.wwmm.opsin.OpsinWarning;

/**
 * Long-lived OPSIN process for the Orbital chemistry API.
 *
 * Protocol (UTF-8, one request per line):  <id>\t<name>
 * Response (one line):  <id>\t<status>\t<smiles>\t<message>\t<flags>
 *   status  SUCCESS | WARNING | FAILURE
 *   flags   comma-separated: ambiguous, stereo_ignored, warning:<TYPE>
 * Tabs and newlines inside fields are replaced with spaces.
 */
public final class OpsinBridge {
    private static String clean(String s) {
        if (s == null) return "";
        return s.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ');
    }

    public static void main(String[] args) throws Exception {
        NameToStructure n2s = NameToStructure.getInstance();
        NameToStructureConfig config = NameToStructureConfig.getDefaultConfigInstance();
        config.setDetailedFailureAnalysis(true);
        config.setWarnRatherThanFailOnUninterpretableStereochemistry(true);
        config.setAllowRadicals(true);

        PrintStream out = new PrintStream(System.out, true, "UTF-8");
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        out.println("READY\t" + NameToStructure.getVersion());
        String line;
        while ((line = in.readLine()) != null) {
            int tab = line.indexOf('\t');
            if (tab < 0) continue;
            String id = line.substring(0, tab);
            String name = line.substring(tab + 1);
            try {
                OpsinResult r = n2s.parseChemicalName(name, config);
                List<String> flags = new ArrayList<>();
                if (r.nameAppearsToBeAmbiguous()) flags.add("ambiguous");
                if (r.stereochemistryIgnored()) flags.add("stereo_ignored");
                for (OpsinWarning w : r.getWarnings()) flags.add("warning:" + w.getType().name());
                String smiles = r.getStatus() == OpsinResult.OPSIN_RESULT_STATUS.FAILURE ? "" : r.getSmiles();
                out.println(id + "\t" + r.getStatus().name() + "\t" + clean(smiles) + "\t" + clean(r.getMessage())
                        + "\t" + String.join(",", flags));
            } catch (Throwable t) {
                out.println(id + "\tFAILURE\t\t" + clean(t.toString()) + "\t");
            }
        }
    }
}
