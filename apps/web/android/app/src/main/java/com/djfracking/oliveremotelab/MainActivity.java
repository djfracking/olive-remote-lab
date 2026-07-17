package com.djfracking.oliveremotelab;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OliveDiscoveryPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
